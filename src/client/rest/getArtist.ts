import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Album, AlbumID3, Artist, userData } from '../../zod.ts';

const getArtist = new Hono();

async function handlegetArtist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artistId = await getField(c, 'id') || '';

    if (!artistId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const Artist = (await database.get(['artists', artistId])).value as Artist | undefined;
    if (!Artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found' });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const userData = (await database.get(['userData', user.backend.id, 'artist', artistId])).value as userData | undefined;
    if (userData) {
        if (userData.starred) Artist.artist.starred = userData.starred.toISOString();
        if (userData.userRating) Artist.artist.userRating = userData.userRating;
    }

    for (let i = 0; i < Artist.artist.album.length; i++) {
        const Album = (await database.get(['albums', Artist.artist.album[i] as string])).value as Album | undefined;
        if (!Album) return createResponse(c, {}, 'failed', { code: 0, message: 'Artist album not found' });
        const album = Album.subsonic;
        // @ts-expect-error A weird error with Deno type checking i guess.
        delete album.song;

        const userData = (await database.get(['userData', user.backend.id, 'album', album.id])).value as userData | undefined;
        if (userData) {
            if (userData.starred) album.starred = userData.starred.toISOString();
            if (userData.played) album.played = userData.played.toISOString();
            if (userData.playCount) album.playCount = userData.playCount;
            if (userData.userRating) album.userRating = userData.userRating;
        }
        Artist.artist.album[i] = album;
    }

    if (Artist.artist.album.length) {
        Artist.artist.album = (Artist.artist.album as AlbumID3[]).sort((a, b) => {
            const numA = parseInt(a.id.slice(1)); // Extract number from "a1", "a2", etc.
            const numB = parseInt(b.id.slice(1));
            return numA - numB;
        });
    }

    return createResponse(c, {
        artist: Artist.artist,
    }, 'ok');
}

getArtist.get('/getArtist', handlegetArtist);
getArtist.post('/getArtist', handlegetArtist);
getArtist.get('/getArtist.view', handlegetArtist);
getArtist.post('/getArtist.view', handlegetArtist);

export default getArtist;
