import { Context, Hono } from '@hono/hono';
import Fuse from 'fuse.js';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Album, Artist, Song, userData } from '../../zod.ts';

const search = new Hono();

async function handlesearch(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const query = (await getField(c, 'query') || '').replace(/[`'"]/g, '').trim();
    const artistCount = parseInt(await getField(c, 'artistCount') || '20');
    let artistOffset = parseInt(await getField(c, 'artistOffset') || '0');
    const albumCount = parseInt(await getField(c, 'albumCount') || '20');
    let albumOffset = parseInt(await getField(c, 'albumOffset') || '0');
    const songCount = parseInt(await getField(c, 'songCount') || '20');
    let songOffset = parseInt(await getField(c, 'songOffset') || '0');
    // const musicFolderId = await getField(c, "musicFolderId") || "";

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const artist = [];
    const album = [];
    const song = [];

    if (artistCount) {
        const maxOffset = (await database.get(['counters', 'A'])).value as number;
        artistOffset = Math.min(artistOffset, maxOffset);
        const Artists = await Array.fromAsync(database.list({ prefix: ['artists'] }));
        const fuse = new Fuse(Artists, { keys: ['value.artist.name'], threshold: 0.3, ignoreLocation: true, useExtendedSearch: true });
        const results = query.length ? fuse.search(query).map((r) => r.item) : Artists;
        const slicedResults = results.slice(artistOffset, artistOffset + artistCount);

        for (const result of slicedResults) {
            const Artist = result.value as Artist;

            const userData = (await database.get(['userData', user.backend.id, 'artist', Artist.artist.id])).value as userData | undefined;
            if (userData) {
                if (userData.starred) Artist.artist.starred = userData.starred.toISOString();
                if (userData.userRating) Artist.artist.userRating = userData.userRating;
            }

            // @ts-expect-error A weird error with Deno type checking i guess.
            delete Artist.artist.album;
            artist.push(Artist.artist);
        }
    }

    if (albumCount) {
        const maxOffset = (await database.get(['counters', 'a'])).value as number;
        albumOffset = Math.min(albumOffset, maxOffset);
        const Albums = await Array.fromAsync(database.list({ prefix: ['albums'] }));
        let results = Albums;

        if (query.length) {
            const formattedAlbums = Albums.map((album) => ({
                ...album,
                searchString: `${(album.value as Album).subsonic.artist} ${(album.value as Album).subsonic.name}`.toLowerCase(),
            }));

            const fuse = new Fuse(formattedAlbums, {
                keys: ['searchString'],
                threshold: 0.3,
                ignoreLocation: true,
                useExtendedSearch: false,
            });
            results = fuse.search(query).map((r) => r.item);
        }

        const slicedResults = results.slice(albumOffset, albumOffset + albumCount);

        for (const result of slicedResults) {
            const Album = (result.value as Album).subsonic;

            const userData = (await database.get(['userData', user.backend.id, 'album', Album.id])).value as userData | undefined;
            if (userData) {
                if (userData.starred) Album.starred = userData.starred.toISOString();
                if (userData.played) Album.played = userData.played.toISOString();
                if (userData.playCount) Album.playCount = userData.playCount;
                if (userData.userRating) Album.userRating = userData.userRating;
            }

            // @ts-expect-error A weird error with Deno type checking i guess.
            delete Album.song;
            album.push(Album);
        }
    }

    if (songCount) {
        const maxOffset = (await database.get(['counters', 't'])).value as number;
        songOffset = Math.min(songOffset, maxOffset);
        const Songs = await Array.fromAsync(database.list({ prefix: ['tracks'] }));
        let results = Songs;

        if (query.length) {
            const formattedSongs = Songs.map((song) => ({
                ...song,
                searchString: `${(song.value as Song).subsonic.artist} ${(song.value as Song).subsonic.album} ${(song.value as Song).subsonic.title}`
                    .toLowerCase(),
            }));

            const fuse = new Fuse(formattedSongs, {
                keys: ['searchString'],
                threshold: 0.3,
                ignoreLocation: true,
                useExtendedSearch: true,
            });
            results = fuse.search(query).map((r) => r.item);
        }

        const slicedResults = results.slice(songOffset, songOffset + songCount);

        for (const result of slicedResults) {
            const track = result.value as Song;
            const userData = (await database.get(['userData', user.backend.id, 'track', track.subsonic.id])).value as userData | undefined;
            if (userData) {
                if (userData.starred) track.subsonic.starred = userData.starred.toISOString();
                if (userData.played) track.subsonic.played = userData.played.toISOString();
                if (userData.playCount) track.subsonic.playCount = userData.playCount;
                if (userData.userRating) track.subsonic.userRating = userData.userRating;
            }
            song.push(track.subsonic);
        }
    }

    return createResponse(c, {
        [/(search|search2)$/.test(c.req.path) ? 'searchResult2' : 'searchResult3']: {
            artist,
            album,
            song,
        },
    }, 'ok');
}

search.get('/search', handlesearch);
search.post('/search', handlesearch);
search.get('/search.view', handlesearch);
search.post('/search.view', handlesearch);

search.get('/search2', handlesearch);
search.post('/search2', handlesearch);
search.get('/search2.view', handlesearch);
search.post('/search2.view', handlesearch);

search.get('/search3', handlesearch);
search.post('/search3', handlesearch);
search.get('/search3.view', handlesearch);
search.post('/search3.view', handlesearch);

export default search;
