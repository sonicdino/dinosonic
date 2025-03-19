import { Context, Hono } from 'hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { Album, Artist, Song, userData } from '../../zod.ts';

const getStarred = new Hono();

async function handlegetStarred(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const artist = [];
    const album = [];
    const song = [];

    const starredTracks = (await Array.fromAsync(database.list({ prefix: ['userData', isValidated.username, 'track'] })))
        .map((entry) => entry.value as userData)
        .filter((data) => data.starred)
        .map((data) => data.id);

    const starredAlbums = (await Array.fromAsync(database.list({ prefix: ['userData', isValidated.username, 'album'] })))
        .map((entry) => entry.value as userData)
        .filter((data) => data.starred)
        .map((data) => data.id);

    const starredArtists = (await Array.fromAsync(database.list({ prefix: ['userData', isValidated.username, 'artist'] })))
        .map((entry) => entry.value as userData)
        .filter((data) => data.starred)
        .map((data) => data.id);

    for (const trackId of starredTracks) {
        const track = (await database.get(['tracks', trackId])).value as Song | undefined;
        if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

        const userData = (await database.get(['userData', isValidated.username, 'track', trackId])).value as userData | undefined;
        if (userData) {
            if (userData.starred) track.subsonic.starred = userData.starred.toISOString();
            if (userData.played) track.subsonic.played = userData.played.toISOString();
            if (userData.playCount) track.subsonic.playCount = userData.playCount;
            if (userData.userRating) track.subsonic.userRating = userData.userRating;
        }

        song.push(track.subsonic);
    }

    for (const albumId of starredAlbums) {
        const Album = (await database.get(['albums', albumId])).value as Album | undefined;
        if (!Album) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

        const userData = (await database.get(['userData', isValidated.username, 'album', albumId])).value as userData | undefined;
        if (userData) {
            if (userData.starred) Album.subsonic.starred = userData.starred.toISOString();
            if (userData.played) Album.subsonic.played = userData.played.toISOString();
            if (userData.playCount) Album.subsonic.playCount = userData.playCount;
            if (userData.userRating) Album.subsonic.userRating = userData.userRating;
        }

        // @ts-expect-error A weird error with Deno type checking i guess.
        delete Album.subsonic.song;

        album.push(Album.subsonic);
    }

    for (const artistId of starredArtists) {
        const Artist = (await database.get(['artists', artistId])).value as Artist | undefined;
        if (!Artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found' });

        const userData = (await database.get(['userData', isValidated.username, 'artist', artistId])).value as userData | undefined;
        if (userData) {
            if (userData.starred) Artist.artist.starred = userData.starred.toISOString();
            if (userData.userRating) Artist.artist.userRating = userData.userRating;
        }

        // @ts-expect-error A weird error with Deno type checking i guess.
        delete Artist.artist.album;

        artist.push(Artist.artist);
    }

    return createResponse(c, {
        [/(getStarred2|getStarred2\.view)$/.test(c.req.path) ? 'starred2' : 'starred']: {
            artist,
            album,
            song,
        },
    }, 'ok');
}

getStarred.get('/getStarred', handlegetStarred);
getStarred.post('/getStarred', handlegetStarred);
getStarred.get('/getStarred.view', handlegetStarred);
getStarred.post('/getStarred.view', handlegetStarred);

getStarred.get('/getStarred2', handlegetStarred);
getStarred.post('/getStarred2', handlegetStarred);
getStarred.get('/getStarred2.view', handlegetStarred);
getStarred.post('/getStarred2.view', handlegetStarred);

export default getStarred;
