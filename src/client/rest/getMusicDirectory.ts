import { Context, Hono } from '@hono/hono';
import { createResponse, getField, validateAuth } from '../../util.ts';

const getMusicDirectory = new Hono();

async function handlegetMusicDirectory(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = parseInt(await getField(c, 'id') || '0');
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    // Dinosonic is not the only Subsonic-like server that does this tomfoolery.
    return createResponse(c, {}, 'failed', { code: 70, message: 'Music directory not found' });
}

getMusicDirectory.get('/getMusicDirectory', handlegetMusicDirectory);
getMusicDirectory.post('/getMusicDirectory', handlegetMusicDirectory);
getMusicDirectory.get('/getMusicDirectory.view', handlegetMusicDirectory);
getMusicDirectory.post('/getMusicDirectory.view', handlegetMusicDirectory);

export default getMusicDirectory;
