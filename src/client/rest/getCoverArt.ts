import { Context, Hono } from '@hono/hono';
import { config, createResponse, database, exists, getField, logger, validateAuth } from '../../util.ts';
import { CoverArt } from '../../zod.ts';
import * as path from '@std/path';

const getCoverArt = new Hono();
const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp', // webp sucks.
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
};

async function handlegetCoverArt(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id');
    const size = parseInt(await getField(c, 'size') || '0');

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const Cover = (await database.get(['covers', id])).value as CoverArt | undefined;
    if (!Cover) return createResponse(c, {}, 'failed', { code: 70, message: 'Cover not found' });
    if (!size) {
        return new Response(await Deno.readFile(Cover.path), {
            headers: {
                'Content-Type': Cover.mimeType,
                'Cache-Control': 'public, max-age=3600',
            },
        });
    }

    const cacheDir = path.join(config.data_folder, 'cache');
    if (!(await exists(cacheDir))) await Deno.mkdir(cacheDir);

    const cacheCoversDir = path.join(cacheDir, 'covers');
    if (!(await exists(cacheCoversDir))) await Deno.mkdir(cacheCoversDir);

    const cachedCoverPath = path.join(cacheCoversDir, `${id}_${size}.${mimeToExt[Cover.mimeType] || 'jpg'}`);
    if (await exists(cachedCoverPath)) {
        return new Response(await Deno.readFile(cachedCoverPath), {
            headers: {
                'Content-Type': Cover.mimeType,
                'Cache-Control': 'public, max-age=3600',
            },
        });
    }

    const process = new Deno.Command(config.transcoding?.ffmpeg_path || 'ffmpeg', {
        args: ['-i', Cover.path, '-vf', `scale=${size}:${size}`, '-y', cachedCoverPath],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const { success, stderr } = await process.output();

    if (!success) {
        const errorMsg = new TextDecoder().decode(stderr);
        logger.error(`FFmpeg failed: ${errorMsg}. Falling back to original.`);
        return new Response(await Deno.readFile(Cover.path), {
            headers: {
                'Content-Type': Cover.mimeType,
                'Cache-Control': 'public, max-age=3600',
            },
        });
    }

    return new Response(await Deno.readFile(cachedCoverPath), {
        headers: {
            'Content-Type': Cover.mimeType,
            'Cache-Control': 'public, max-age=3600',
        },
    });
}

getCoverArt.get('/getCoverArt', handlegetCoverArt);
getCoverArt.post('/getCoverArt', handlegetCoverArt);
getCoverArt.get('/getCoverArt.view', handlegetCoverArt);
getCoverArt.post('/getCoverArt.view', handlegetCoverArt);

export default getCoverArt;
