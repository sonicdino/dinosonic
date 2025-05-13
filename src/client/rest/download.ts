import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';

const download = new Hono();

async function handledownload(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.downloadRole) return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to download' });
    const id = await getField(c, 'id');
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const track = (await database.get(['tracks', id])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    const file = await Deno.readFile(track.subsonic.path);
    return new Response(file, {
        headers: {
            'Content-Type': track.subsonic.contentType || 'audio/mpeg',
        },
    });
}

download.get('/download', handledownload);
download.post('/download', handledownload);
download.get('/download.view', handledownload);
download.post('/download.view', handledownload);

export default download;
