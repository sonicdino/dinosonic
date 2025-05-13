import { Context, Hono } from '@hono/hono';
import { createResponse, validateAuth } from '../../util.ts';

const getMusicFolders = new Hono();

async function handlegetMusicFolders(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    // Hard coded "virtual" music folder. This is because it is unecessarry to just display the actual dir since we just walked through the directory. the music folder will be an imitation.
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
