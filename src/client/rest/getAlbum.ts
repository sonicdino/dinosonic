import { Context, Hono } from 'hono';
import { createResponse, database, ERROR_MESSAGES, validateAuth } from '../../util.ts';
import { AlbumID3, Song, userData } from '../../zod.ts';

const getAlbum = new Hono();

async function handlegetAlbum(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const albumId = c.req.query('id') || '';

    if (!albumId) return createResponse(c, {}, 'failed', { code: 10, message: ERROR_MESSAGES[10] });
    const album = (await database.get(['albums', albumId])).value as AlbumID3 | undefined;
    if (!album) return createResponse(c, {}, 'failed', { code: 70, message: ERROR_MESSAGES[70] });

    const userData = (await database.get(['userData', isValidated.username, 'album', albumId])).value as userData | undefined;
    if (userData) {
        if (userData.starred) album.starred = userData.starred.toISOString();
        if (userData.played) album.played = userData.played.toISOString();
        if (userData.playCount) album.playCount = userData.playCount;
        if (userData.userRating) album.userRating = userData.userRating;
    }

    for (let i = 0; i < album.song.length; i++) {
        const track = (await database.get(['tracks', album.song[i] as string])).value as Song | undefined;
        if (!track) return createResponse(c, {}, 'failed', { code: 0, message: ERROR_MESSAGES[0] });

        const userData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
        if (userData) {
            if (userData.starred) track.subsonic.starred = userData.starred.toISOString();
            if (userData.played) track.subsonic.played = userData.played.toISOString();
            if (userData.playCount) track.subsonic.playCount = userData.playCount;
            if (userData.userRating) track.subsonic.userRating = userData.userRating;
        }
        // @ts-expect-error This expect error will most likely be left on, but it will stay in here.
        album.song[i] = track.subsonic;
    }

    return createResponse(c, {
        album,
    }, 'ok');
}

getAlbum.get('/getAlbum', handlegetAlbum);
getAlbum.post('/getAlbum', handlegetAlbum);
getAlbum.get('/getAlbum.view', handlegetAlbum);
getAlbum.post('/getAlbum.view', handlegetAlbum);

export default getAlbum;
