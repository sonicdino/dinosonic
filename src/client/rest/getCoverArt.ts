import { Context, Hono } from 'hono';
import { createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { CoverArt } from '../../zod.ts';

const getCoverArt = new Hono();

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

    const process = new Deno.Command('ffmpeg', {
        args: ['-i', Cover.path, '-vf', `scale=${size}:${size}`, '-f', 'image2pipe', 'pipe:1'],
        stdout: 'piped',
        stderr: 'piped',
    }).spawn();

    const { success, stdout, stderr } = await process.output();

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

    return new Response(stdout, {
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
