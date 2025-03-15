import { Context, Hono } from 'hono';
import { createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { CoverArt } from '../../zod.ts';

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
    let cover: Uint8Array = await Deno.readFile(Cover.path);

    if (size) {
        const tmpDir = await Deno.makeTempDir();
        const outputFilePath = `${tmpDir}/cover.${mimeToExt[Cover.mimeType]}`;

        const command = new Deno.Command('ffmpeg', {
            args: ['-i', Cover.path, '-vf', `scale=${size}:${size}`, outputFilePath],
            stdout: 'piped',
            stderr: 'piped',
        });
        const process = await command.output();

        if (process.success) {
            cover = await Deno.readFile(outputFilePath);
            await Deno.remove(tmpDir, { recursive: true });
        } else {
            logger.debug('Failed to resize cover art. Falling back to original.');
        }
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
