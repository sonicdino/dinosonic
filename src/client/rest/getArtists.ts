import { Context, Hono } from 'hono';
import { createResponse, database, ERROR_MESSAGES, validateAuth } from '../../util.ts';
import { AlbumID3, ArtistID3, userData } from '../../zod.ts';

const getArtists = new Hono();

async function handlegetArtists(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const artists = [];

    for await (const entry of database.list({ prefix: ['artists'] })) {
        const artist = entry.value as ArtistID3;
        const artistId = artist.id;

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

        artists.push(artist);
    }

    return createResponse(c, {
        artists: artists.sort((a, b) => {
            const numA = parseInt(a.id.slice(1), 10);
            const numB = parseInt(b.id.slice(1), 10);
            return numA - numB;
        }),
    }, 'ok');
}

getArtists.get('/getArtists', handlegetArtists);
getArtists.post('/getArtists', handlegetArtists);
getArtists.get('/getArtists.view', handlegetArtists);
getArtists.post('/getArtists.view', handlegetArtists);

export default getArtists;
