import { Context, Hono } from '@hono/hono';
import { createResponse, validateAuth } from '../../util.ts';

const getMusicFolders = new Hono();

async function handlegetMusicFolders(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    return createResponse(c, {
        musicFolders: {
            musicFolder: [
                {
                    id: 1,
                    name: 'Music Library',
                },
            ],
        },
    }, 'ok');
}

getMusicFolders.get('/getMusicFolders', handlegetMusicFolders);
getMusicFolders.post('/getMusicFolders', handlegetMusicFolders);
getMusicFolders.get('/getMusicFolders.view', handlegetMusicFolders);
getMusicFolders.post('/getMusicFolders.view', handlegetMusicFolders);

export default getMusicFolders;
