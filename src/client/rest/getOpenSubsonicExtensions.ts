import { Context, Hono } from '@hono/hono';
import { createResponse } from '../../util.ts';

const getOpenSubsonicExtensions = new Hono();

function handlegetOpenSubsonicExtensions(c: Context) {
    return createResponse(c, {
        openSubsonicExtensions: [
            {
                name: 'formPost',
                versions: [1],
            },
            {
                name: 'songLyrics',
                versions: [1],
            },
            {
                name: 'transcodeOffset',
                versions: [1],
            },
            {
                name: 'songLyrics',
                versions: [1],
            },
            {
                name: 'indexBasedQueue',
                versions: [1],
            }
        ],
    }, 'ok');
}

getOpenSubsonicExtensions.get('/getOpenSubsonicExtensions', handlegetOpenSubsonicExtensions);
getOpenSubsonicExtensions.post('/getOpenSubsonicExtensions', handlegetOpenSubsonicExtensions);
getOpenSubsonicExtensions.get('/getOpenSubsonicExtensions.view', handlegetOpenSubsonicExtensions);
getOpenSubsonicExtensions.post('/getOpenSubsonicExtensions.view', handlegetOpenSubsonicExtensions);

export default getOpenSubsonicExtensions;
