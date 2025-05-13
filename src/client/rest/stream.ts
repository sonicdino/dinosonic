import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, getField, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';

const stream = new Hono();

async function handleStream(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.streamRole) return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to stream' });

    const id = await getField(c, 'id');
    const format = await getField(c, 'format') || 'original';
    const maxBitRate = parseInt(await getField(c, 'maxBitRate') || '0');
    const timeOffset = parseInt(await getField(c, 'timeOffset') || '0');
    const estimateContentLength = await getField(c, 'estimateContentLength') === 'true';

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const track = (await database.get(['tracks', id])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    if (format === 'original' && maxBitRate === 0) {
        const file = await Deno.open(track.subsonic.path, { read: true });
        const { size } = await file.stat();

        const rangeHeader = c.req.header('Range');
        let start = 0;
        let end = size - 1;

        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                start = parseInt(match[1], 10);
                end = match[2] ? parseInt(match[2], 10) : end;
            }
        }

        const contentLength = end - start + 1;

        // Set headers for range requests
        c.header('Accept-Ranges', 'bytes');
        c.header('Content-Type', track.subsonic.contentType || 'audio/mpeg');
        c.header('Content-Length', `${contentLength}`);

        if (rangeHeader) {
            c.status(206); // Partial Content
            c.header('Content-Range', `bytes ${start}-${end}/${size}`);
        }

        // Create a stream starting from the correct position
        await file.seek(start, Deno.SeekMode.Start); // Correct way to seek in Deno 2.x

        const readable = new ReadableStream({
            async pull(controller) {
                const buffer = new Uint8Array(64 * 1024); // 64 KB buffer for stability
                const bytesRead = await file.read(buffer);

                if (bytesRead === null || bytesRead === 0) {
                    controller.close();
                    file.close();
                } else {
                    controller.enqueue(buffer.subarray(0, bytesRead));
                }
            },
            cancel() {
                file.close();
            },
        });

        return c.body(readable);
    }

    const ffmpegArgs = [
        '-i',
        track.subsonic.path,
        '-ss',
        timeOffset.toString(), // Seek position
        '-map',
        '0:a', // Extract only audio
    ];

    if (maxBitRate > 0) {
        ffmpegArgs.push('-b:a', `${maxBitRate}k`);
    }

    if (format !== 'original') {
        ffmpegArgs.push('-f', format);
    }

    ffmpegArgs.push('pipe:1'); // Output to stdout

    const ffmpeg = new Deno.Command(config.transcoding?.ffmpeg_path || 'ffmpeg', {
        args: ffmpegArgs,
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    let estimatedSize: number | undefined;
    if (estimateContentLength) {
        const avgBitrate = maxBitRate > 0 ? maxBitRate : track.subsonic.bitRate || 256;
        const durationInSeconds = track.subsonic.duration - timeOffset;
        estimatedSize = Math.ceil((durationInSeconds * (avgBitrate * 1024)) / 8);
    }

    const streamReader = ffmpeg.stdout.getReader();
    const stream = new ReadableStream({
        async pull(controller) {
            const { value, done } = await streamReader.read();
            if (done) {
                controller.close();
            } else {
                controller.enqueue(value);
            }
        },
        cancel() {
            streamReader.releaseLock();
            ffmpeg.kill();
        },
    });

    // Set correct headers
    c.header('Content-Type', format === 'original' ? track.subsonic.contentType || 'audio/mpeg' : `audio/${format}`);
    c.header('Transfer-Encoding', 'chunked');
    if (estimateContentLength && estimatedSize) {
        c.header('Content-Length', `${Math.floor(estimatedSize)}`);
    }

    return c.body(stream);
}

stream.get('/stream', handleStream);
stream.post('/stream', handleStream);
stream.get('/stream.view', handleStream);
stream.post('/stream.view', handleStream);

export default stream;
