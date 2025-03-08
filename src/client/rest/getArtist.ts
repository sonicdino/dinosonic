import { Context, Hono } from 'hono';
import { createResponse, database, ERROR_MESSAGES, validateAuth } from '../../util.ts';
import { AlbumID3, ArtistID3, userData } from '../../zod.ts';

const getArtist = new Hono();

async function handlegetArtist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artistId = c.req.query('id') || '';

    if (!artistId) return createResponse(c, {}, 'failed', { code: 10, message: ERROR_MESSAGES[10] });
    const artist = (await database.get(['artists', artistId])).value as ArtistID3 | undefined;
    if (!artist) return createResponse(c, {}, 'failed', { code: 70, message: ERROR_MESSAGES[70] });

    const userData = (await database.get(['userData', isValidated.username, 'artist', artistId])).value as userData | undefined;
    if (userData) {
        if (userData.starred) artist.starred = userData.starred.toISOString();
        if (userData.userRating) artist.userRating = userData.userRating;
    }

    for (let i = 0; i < artist.album.length; i++) {
        const album = (await database.get(['albums', artist.album[i] as string])).value as AlbumID3 | undefined;
        if (!album) return createResponse(c, {}, 'failed', { code: 0, message: ERROR_MESSAGES[0] });
        // @ts-expect-error A weird error with Deno type checking i guess.
        delete album.song;

        const userData = (await database.get(['userData', isValidated.username, 'album', album.id])).value as userData | undefined;
        if (userData) {
            if (userData.starred) album.starred = userData.starred.toISOString();
            if (userData.played) album.played = userData.played.toISOString();
            if (userData.playCount) album.playCount = userData.playCount;
            if (userData.userRating) album.userRating = userData.userRating;
        }
        artist.album[i] = album;
    }

    return createResponse(c, {
        artist,
    }, 'ok');
}

getArtist.get('/getArtist', handlegetArtist);
getArtist.post('/getArtist', handlegetArtist);
getArtist.get('/getArtist.view', handlegetArtist);
getArtist.post('/getArtist.view', handlegetArtist);

export default getArtist;
