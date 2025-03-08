import { Context, Hono } from 'hono';
import fuzzy from 'fuzzy';
import { createResponse, database, ERROR_MESSAGES, validateAuth } from '../../util.ts';
import { AlbumID3, ArtistID3, Song } from '../../zod.ts';

const search = new Hono();

async function handlesearch(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const path = c.req.path;
    const query = c.req.query('query') || '';
    const artistCount = parseInt(c.req.query('artistCount') || '20');
    let artistOffset = parseInt(c.req.query('artistOffset') || '0');
    const albumCount = parseInt(c.req.query('albumCount') || '20');
    let albumOffset = parseInt(c.req.query('albumOffset') || '0');
    const songCount = parseInt(c.req.query('songCount') || '20');
    let songOffset = parseInt(c.req.query('songOffset') || '0');
    // const musicFolderId = c.req.query("musicFolderId") || "";

    const objectName = /(search|search2)$/.test(path) ? 'searchResult2' : 'searchResult3';
    const artist = [];
    const album = [];
    const song = [];

    if (!query) return createResponse(c, {}, 'failed', { code: 10, message: ERROR_MESSAGES[10] });

    if (artistCount) {
        const maxOffset = (await database.get(['counters', 'A'])).value as number;
        artistOffset = Math.min(artistOffset, maxOffset);
        const Artists = await Array.fromAsync(database.list({ prefix: ['artists'] }));
        const results = fuzzy.filter(query, Artists, { extract: (artist) => (artist.value as ArtistID3).name });
        const artists = [];
        let skipped = 0;

        for (const entry of results) {
            if (skipped < artistOffset) {
                skipped++;
                continue; // Skip items until offset is reached
            }
            artists.push(entry);
            if (artists.length >= artistCount) break; // Stop after collecting `limit` items
        }

        for (const result of artists) {
            const Artist = result.original.value as ArtistID3;
            // @ts-expect-error A weird error with Deno type checking i guess.
            delete Artist.album;
            artist.push(Artist);
        }
    }

    if (albumCount) {
        const maxOffset = (await database.get(['counters', 'a'])).value as number;
        albumOffset = Math.min(albumOffset, maxOffset);
        const Albums = await Array.fromAsync(database.list({ prefix: ['albums'] }));
        const results = fuzzy.filter(query, Albums, { extract: (album) => (album.value as AlbumID3).name });
        const albums = [];
        let skipped = 0;

        for (const entry of results) {
            if (skipped < albumOffset) {
                skipped++;
                continue; // Skip items until offset is reached
            }
            albums.push(entry);
            if (albums.length >= artistCount) break; // Stop after collecting `limit` items
        }

        for (const result of albums) {
            const Album = result.original.value as AlbumID3;
            // @ts-expect-error A weird error with Deno type checking i guess.
            delete Album.song;
            album.push(Album);
        }
    }

    if (songCount) {
        const maxOffset = (await database.get(['counters', 't'])).value as number;
        songOffset = Math.min(songOffset, maxOffset);
        const Songs = await Array.fromAsync(database.list({ prefix: ['tracks'] }));
        const results = fuzzy.filter(query, Songs, {
            extract: (song) =>
                `${(song.value as Song).subsonic.artist} ${(song.value as Song).subsonic.album} ${(song.value as Song).subsonic.title}`,
        });
        const songs = [];
        let skipped = 0;

        for (const entry of results) {
            if (skipped < songOffset) {
                skipped++;
                continue; // Skip items until offset is reached
            }
            songs.push(entry);
            if (songs.length >= artistCount) break; // Stop after collecting `limit` items
        }

        for (const result of songs) {
            song.push((result.original.value as Song).subsonic);
        }
    }

    return createResponse(c, {
        [objectName]: {
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
