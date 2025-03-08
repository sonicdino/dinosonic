import { Context, Hono } from 'hono';
import { createResponse, database, ERROR_MESSAGES, validateAuth } from '../../util.ts';
import { resize } from 'deno_image';
import { CoverArt } from '../../zod.ts';

const getCoverArt = new Hono();

async function handlegetCoverArt(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = c.req.query('id');
    const size = parseInt(c.req.query('size') || '0');

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: ERROR_MESSAGES[10] });

    const Cover = (await database.get(['covers', id])).value as CoverArt | undefined;
    if (!Cover) return createResponse(c, {}, 'failed', { code: 70, message: ERROR_MESSAGES[70] });
    let cover: Uint8Array = await Deno.readFile(Cover.path);

    if (size) {
        cover = await resize(cover, {
            width: size,
            height: size,
        });
    }

    return new Response(cover, {
        headers: {
            'Content-Type': Cover.mimeType,
            'Content-Length': cover.length.toString(),
            'Cache-Control': 'public, max-age=3600',
        },
    });
}

getCoverArt.get('/getCoverArt', handlegetCoverArt);
getCoverArt.post('/getCoverArt', handlegetCoverArt);
getCoverArt.get('/getCoverArt.view', handlegetCoverArt);
getCoverArt.post('/getCoverArt.view', handlegetCoverArt);

export default getCoverArt;
