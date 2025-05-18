import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { CoverArtSchema } from '../../zod.ts'; // Use CoverArtSchema for parsing
import * as path from '@std/path';
import { ensureDir } from '@std/fs/ensure-dir'; // Import ensureDir
import { exists } from '@std/fs/exists'; // exists is still useful for checking cached file

const getCoverArt = new Hono();
const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
};

async function handleGetCoverArt(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id');
    const size = parseInt(await getField(c, 'size') || '0');

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const coverEntry = await database.get(['covers', id]);
    if (!coverEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Cover not found' });

    const parsedCover = CoverArtSchema.safeParse(coverEntry.value);
    if (!parsedCover.success) {
        logger.error(`Malformed cover art data in DB for ID ${id}`);
        return createResponse(c, {}, 'failed', { code: 70, message: 'Cover data corrupted' });
    }
    const cover = parsedCover.data;

    // Check if the original cover path exists
    if (!(await exists(cover.path))) {
        logger.error(`Original cover file not found at path: ${cover.path} for ID ${id}`);
        // Optionally, try to regenerate or find it, or return a placeholder/404
        return createResponse(c, {}, 'failed', { code: 70, message: 'Original cover file missing' });
    }

    if (!size || !config.transcoding?.enabled || !config.transcoding.ffmpeg_path) {
        try {
            return new Response(await Deno.readFile(cover.path), {
                headers: {
                    'Content-Type': cover.mimeType,
                    'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
                },
            });
        } catch (e) {
            logger.error(`Error reading original cover file ${cover.path} for ID ${id}: ${e}`);
            return createResponse(c, {}, 'failed', { code: 500, message: 'Error serving original cover' });
        }
    }

    const cacheCoversDir = path.join(config.data_folder, 'cache', 'covers');
    await ensureDir(cacheCoversDir); // Use ensureDir here

    const ext = mimeToExt[cover.mimeType.toLowerCase()] || 'jpg';
    const cachedCoverPath = path.join(cacheCoversDir, `${id}_${size}.${ext}`);

    if (await exists(cachedCoverPath)) {
        try {
            return new Response(await Deno.readFile(cachedCoverPath), {
                headers: {
                    'Content-Type': cover.mimeType,
                    'Cache-Control': 'public, max-age=86400', // Longer cache for resized
                },
            });
        } catch (e) {
            logger.warn(`Error reading cached cover ${cachedCoverPath}, will attempt to regenerate: ${e}`);
            // Proceed to regenerate if reading fails
        }
    }

    // Check for ffmpeg path again, more robustly
    const ffmpegPath = config.transcoding?.ffmpeg_path;
    if (!ffmpegPath) {
        logger.error(`FFmpeg path not configured. Cannot resize cover for ID ${id}. Falling back to original.`);
        // Fallback to original if ffmpeg isn't configured, even if transcoding is "enabled"
        return new Response(await Deno.readFile(cover.path), {
            headers: { 'Content-Type': cover.mimeType, 'Cache-Control': 'public, max-age=3600' },
        });
    }

    logger.debug(`Resizing cover for ID ${id} to size ${size}, output: ${cachedCoverPath}`);
    const process = new Deno.Command(ffmpegPath, {
        args: ['-i', cover.path, '-vf', `scale=${size}:${size}`, '-y', cachedCoverPath],
        stdout: 'piped',
        stderr: 'piped',
    });

    try {
        const { success, stderr, stdout } = await process.output();

        if (!success) {
            const errorMsg = new TextDecoder().decode(stderr);
            const stdoutMsg = new TextDecoder().decode(stdout);
            logger.error(`FFmpeg failed for cover ${id} (size ${size}): ${errorMsg}\nFFmpeg stdout: ${stdoutMsg}`);
            // Fallback to original if FFmpeg fails
            return new Response(await Deno.readFile(cover.path), {
                headers: {
                    'Content-Type': cover.mimeType,
                    'Cache-Control': 'public, max-age=3600',
                },
            });
        }

        if (!(await exists(cachedCoverPath))) {
            logger.error(`FFmpeg reported success for cover ${id} (size ${size}) but output file ${cachedCoverPath} not found. Falling back.`);
            return new Response(await Deno.readFile(cover.path), {
                headers: { 'Content-Type': cover.mimeType, 'Cache-Control': 'public, max-age=3600' },
            });
        }

        return new Response(await Deno.readFile(cachedCoverPath), {
            headers: {
                'Content-Type': cover.mimeType,
                'Cache-Control': 'public, max-age=86400', // Longer cache for successfully resized
            },
        });
        // deno-lint-ignore no-explicit-any
    } catch (e: any) {
        logger.error(`Error during FFmpeg processing for cover ${id} (size ${size}): ${e.message}. Falling back to original.`);
        return new Response(await Deno.readFile(cover.path), {
            headers: { 'Content-Type': cover.mimeType, 'Cache-Control': 'public, max-age=3600' },
        });
    }
}

getCoverArt.get('/getCoverArt', handleGetCoverArt);
getCoverArt.post('/getCoverArt', handleGetCoverArt);
getCoverArt.get('/getCoverArt.view', handleGetCoverArt);
getCoverArt.post('/getCoverArt.view', handleGetCoverArt);

export default getCoverArt;
