import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';
import * as path from '@std/path';
import { ensureDir } from '@std/fs/ensure-dir';
import { exists } from '@std/fs/exists';

const stream = new Hono();

async function serveFile(c: Context, filePath: string, contentType: string) {
    try {
        const file = await Deno.open(filePath, { read: true });
        const { size } = await file.stat();

        const rangeHeader = c.req.header('Range');
        let start = 0;
        let end = size - 1;
        let status = 200;

        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                start = parseInt(match[1], 10);
                end = match[2] ? parseInt(match[2], 10) : end;
                status = 206;
                c.status(206);
            }
        }

        const contentLength = end - start + 1;

        c.header('Accept-Ranges', 'bytes');
        c.header('Content-Type', contentType);
        c.header('Content-Length', `${contentLength}`);
        c.header('Cache-Control', 'public, max-age=86400');

        if (status === 206) {
            c.header('Content-Range', `bytes ${start}-${end}/${size}`);
        }

        await file.seek(start, Deno.SeekMode.Start);

        const readable = new ReadableStream({
            async pull(controller) {
                const buffer = new Uint8Array(64 * 1024);
                try {
                    const bytesRead = await file.read(buffer);
                    if (bytesRead === null || bytesRead === 0) {
                        controller.close();
                        file.close();
                    } else {
                        controller.enqueue(buffer.subarray(0, bytesRead));
                    }
                } catch (e) {
                    logger.error(`Error reading file stream for ${filePath}: ${e}`);
                    controller.error(e);
                    file.close();
                }
            },
            cancel() {
                file.close();
            },
        });

        return c.body(readable);
    } catch (e) {
        logger.error(`Could not open or stat file ${filePath}: ${e}`);
        return createResponse(c, {}, 'failed', { code: 70, message: 'Song file not found or unreadable' });
    }
}

async function handleStream(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.streamRole) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to stream' });
    }

    const id = await getField(c, 'id');
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const track = (await database.get(['tracks', id])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    const format = await getField(c, 'format') || 'original';
    const maxBitRate = parseInt(await getField(c, 'maxBitRate') || '0');
    const timeOffset = parseInt(await getField(c, 'timeOffset') || '0');

    const isTranscoding = format !== 'original' || maxBitRate > 0;

    if (!isTranscoding) {
        return serveFile(c, track.subsonic.path, track.subsonic.contentType || 'audio/mpeg');
    }

    const ffmpegPath = config.transcoding?.ffmpeg_path || 'ffmpeg';
    if (!config.transcoding?.enabled) {
        logger.warn(`Transcoding is disabled, but a transcode was requested for song ${id}. Serving original.`);
        return serveFile(c, track.subsonic.path, track.subsonic.contentType || 'audio/mpeg');
    }

    if (timeOffset > 0) {
        logger.debug(`Live transcoding stream for song ${id} with offset ${timeOffset}s.`);
        const ffmpegArgs = [
            '-i', track.subsonic.path,
            '-map_metadata', '-1',
            '-ss', timeOffset.toString(),
            '-map', '0:a',
            ...(maxBitRate > 0 ? ['-b:a', `${maxBitRate}k`] : []),
            ...(format !== 'original' ? ['-f', format] : []),
            'pipe:1',
        ];

        const ffmpeg = new Deno.Command(ffmpegPath, { args: ffmpegArgs, stdout: 'piped', stderr: 'piped' }).spawn();
        const stream = ffmpeg.stdout;

        c.header('Content-Type', format === 'original' ? track.subsonic.contentType || 'audio/mpeg' : `audio/${format}`);
        c.header('Transfer-Encoding', 'chunked');

        return c.body(stream);
    }

    const cacheSongsDir = path.join(globalThis.__tmpDir, 'cache', 'songs');
    await ensureDir(cacheSongsDir);

    const effectiveFormat = format === 'original'
        ? path.extname(track.subsonic.path).substring(1) || 'mp3'
        : format;
    const cachedSongPath = path.join(cacheSongsDir, `${id}_${maxBitRate}k.${effectiveFormat}`);
    const tempCachedSongPath = `${cachedSongPath}.${Date.now()}.tmp`;

    if (await exists(cachedSongPath)) {
        logger.debug(`Serving cached transcoded song: ${cachedSongPath}`);
        return serveFile(c, cachedSongPath, `audio/${effectiveFormat}`);
    }

    logger.debug(`Transcoding and caching song ${id} to ${cachedSongPath}`);
    const process = new Deno.Command(ffmpegPath, {
        args: [
            '-i', track.subsonic.path,
            '-map_metadata', '-1',
            '-map', '0:a',
            ...(maxBitRate > 0 ? ['-b:a', `${maxBitRate}k`] : []),
            ...(format !== 'original' ? ['-f', format] : []),
            '-y',
            tempCachedSongPath,
        ],
        stdout: 'piped',
        stderr: 'piped',
    });

    try {
        const { success, stderr } = await process.output();
        if (!success) {
            const errorMsg = new TextDecoder().decode(stderr);
            logger.error(`FFmpeg failed for song ${id}: ${errorMsg}`);
            if (await exists(tempCachedSongPath)) await Deno.remove(tempCachedSongPath);
            return createResponse(c, {}, 'failed', { code: 40, message: 'Error during transcoding' });
        }

        await Deno.rename(tempCachedSongPath, cachedSongPath);

        logger.debug(`Finished caching ${cachedSongPath}, now serving.`);
        return serveFile(c, cachedSongPath, `audio/${effectiveFormat}`);
        // deno-lint-ignore no-explicit-any
    } catch (e: any) {
        logger.error(`Error during FFmpeg processing for song ${id}: ${e.message}.`);
        if (await exists(tempCachedSongPath)) await Deno.remove(tempCachedSongPath);
        return createResponse(c, {}, 'failed', { code: 40, message: 'Server error during transcoding' });
    }
}

stream.get('/stream', handleStream);
stream.post('/stream', handleStream);
stream.get('/stream.view', handleStream);
stream.post('/stream.view', handleStream);

export default stream;