import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';
import * as path from '@std/path';
import { ensureDir } from '@std/fs/ensure-dir';
import { exists } from '@std/fs/exists';

const getTranscodeStream = new Hono();

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

        if (status === 206) c.header('Content-Range', `bytes ${start}-${end}/${size}`);

        await file.seek(start, Deno.SeekMode.Start);

        const readable = new ReadableStream({
            async pull(controller) {
                if (controller.desiredSize === null) {
                    file.close();
                    return;
                }

                const buffer = new Uint8Array(64 * 1024);
                try {
                    const bytesRead = await file.read(buffer);
                    if (bytesRead === null || bytesRead === 0) {
                        controller.close();
                        file.close();
                        return;
                    }
                    controller.enqueue(buffer.subarray(0, bytesRead));
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

async function handleGetTranscodeStream(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.streamRole) return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to stream' });

    const mediaId = await getField(c, 'mediaId');
    if (!mediaId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'mediaId'" });

    const mediaType = await getField(c, 'mediaType');
    if (!mediaType || (mediaType !== 'song' && mediaType !== 'podcast')) {
        return createResponse(c, {}, 'failed', {
            code: 10,
            message: "Bad Request: Invalid or missing mediaType parameter. Must be 'song' or 'podcast'",
        });
    }

    const transcodeParams = await getField(c, 'transcodeParams');
    if (!transcodeParams) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'transcodeParams'" });

    const offset = parseInt(await getField(c, 'offset') || '0');

    const track = (await database.get(['tracks', mediaId])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: `${mediaType === 'song' ? 'Song' : 'Podcast'} not found` });

    const ffmpegPath = config.transcoding?.ffmpeg_path || 'ffmpeg';
    if (!config.transcoding?.enabled) {
        logger.warn(`Transcoding is disabled, but getTranscodeStream was requested for ${mediaType} ${mediaId}. Serving original.`);
        return serveFile(c, track.subsonic.path, track.subsonic.contentType || 'audio/mpeg');
    }

    const paramsParts = transcodeParams.split('-');
    if (paramsParts.length < 3) {
        logger.error(`Invalid transcodeParams format: ${transcodeParams}`);
        return createResponse(c, {}, 'failed', { code: 70, message: 'Bad Request: Invalid transcodeParams format' });
    }

    const targetContainer = paramsParts[1];
    const targetBitrate = parseInt(paramsParts[2]);

    logger.debug(`Transcoding stream for ${mediaType} ${mediaId}: container=${targetContainer}, bitrate=${targetBitrate}, offset=${offset}`);

    if (offset > 0) {
        const ffmpegArgs = [
            '-i',
            track.subsonic.path,
            '-map_metadata',
            '-1',
            '-ss',
            offset.toString(),
            '-map',
            '0:a',
            '-b:a',
            `${targetBitrate}`,
            '-f',
            targetContainer,
            'pipe:1',
        ];

        const ffmpeg = new Deno.Command(ffmpegPath, { args: ffmpegArgs, stdout: 'piped', stderr: 'piped' }).spawn();
        const stream = ffmpeg.stdout;

        c.header('Content-Type', `audio/${targetContainer}`);
        c.header('Transfer-Encoding', 'chunked');

        return c.body(stream);
    }

    const cacheSongsDir = path.join(globalThis.__tmpDir, 'cache', 'transcode-songs');
    await ensureDir(cacheSongsDir);

    const cachedSongPath = path.join(cacheSongsDir, `${mediaId}_${targetBitrate}.${targetContainer}`);
    const tempCachedSongPath = `${cachedSongPath}.${Date.now()}.tmp`;

    if (await exists(cachedSongPath)) {
        logger.debug(`Serving cached transcoded ${mediaType}: ${cachedSongPath}`);
        return serveFile(c, cachedSongPath, `audio/${targetContainer}`);
    }

    logger.debug(`Transcoding and caching ${mediaType} ${mediaId} to ${cachedSongPath}`);
    const process = new Deno.Command(ffmpegPath, {
        args: [
            '-i',
            track.subsonic.path,
            '-map_metadata',
            '-1',
            '-map',
            '0:a',
            '-b:a',
            `${targetBitrate}`,
            '-f',
            targetContainer,
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
            logger.error(`FFmpeg failed for ${mediaType} ${mediaId}: ${errorMsg}`);
            if (await exists(tempCachedSongPath)) await Deno.remove(tempCachedSongPath);
            return createResponse(c, {}, 'failed', { code: 70, message: 'Server Error: Transcoding failed' });
        }

        await Deno.rename(tempCachedSongPath, cachedSongPath);

        logger.debug(`Finished caching ${cachedSongPath}, now serving.`);
        return serveFile(c, cachedSongPath, `audio/${targetContainer}`);
        // deno-lint-ignore no-explicit-any
    } catch (e: any) {
        logger.error(`Error during FFmpeg processing for ${mediaType} ${mediaId}: ${e.message}.`);
        if (await exists(tempCachedSongPath)) await Deno.remove(tempCachedSongPath);
        return createResponse(c, {}, 'failed', { code: 70, message: 'Server Error: Transcoding failed' });
    }
}

getTranscodeStream.get('/getTranscodeStream', handleGetTranscodeStream);
getTranscodeStream.post('/getTranscodeStream', handleGetTranscodeStream);
getTranscodeStream.get('/getTranscodeStream.view', handleGetTranscodeStream);
getTranscodeStream.post('/getTranscodeStream.view', handleGetTranscodeStream);

export default getTranscodeStream;
