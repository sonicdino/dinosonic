import { Context, Hono } from 'hono';
import fuzzy from 'fuzzy';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
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

    const artist = [];
    const album = [];
    const song = [];

    // TODO: Optimize search for less ram usage. Maybe impossible because of how Deno.openKv works. It is still an unstable feature after all.
    // Searching will make the ram usage SKYROCKET for a few minutes depending on how many tracks you have. For me, about 13 THOUSAND tracks bump ram usage to 1.5GiBs.
    if (artistCount) {
        const maxOffset = (await database.get(['counters', 'A'])).value as number;
        artistOffset = Math.min(artistOffset, maxOffset);
        const Artists = await Array.fromAsync(database.list({ prefix: ['artists'] }));
        let filteredArtists;
        const artists = [];
        let skipped = 0;

        if (query.length) {
            const results = fuzzy.filter(query, Artists, { extract: (artist) => (artist.value as Artist).artist.name });
            filteredArtists = results.map((result) => result.original);
        } else {
            filteredArtists = Artists;
        }

        for (const entry of filteredArtists) {
            if (skipped < artistOffset) {
                skipped++;
                continue; // Skip items until offset is reached
            }
            artists.push(entry);
            if (artists.length >= artistCount) break; // Stop after collecting `limit` items
        }

        for (const result of artists) {
            const Artist = result.value as Artist;

            const userData = (await database.get(['userData', isValidated.username, 'artist', Artist.artist.id])).value as userData | undefined;
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
        let filteredAlbums;
        const albums = [];
        let skipped = 0;

        if (query.length) {
            const results = fuzzy.filter(query, Albums, {
                extract: (album) => `${(album.value as Album).subsonic.artist} ${(album.value as Album).subsonic.name}`,
            });
            filteredAlbums = results.map((result) => result.original);
        } else {
            filteredAlbums = Albums;
        }

        for (const entry of filteredAlbums) {
            if (skipped < albumOffset) {
                skipped++;
                continue; // Skip items until offset is reached
            }
            albums.push(entry);
            if (albums.length >= albumCount) break; // Stop after collecting `limit` items
        }

        for (const result of albums) {
            const Album = (result.value as Album).subsonic;

            const userData = (await database.get(['userData', isValidated.username, 'album', Album.id])).value as userData | undefined;
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
        let filteredSongs = [];
        const songs = [];
        let skipped = 0;

        if (query.length) {
            const results = fuzzy.filter(query, Songs, {
                extract: (song) =>
                    `${(song.value as Song).subsonic.artist} ${(song.value as Song).subsonic.album} ${(song.value as Song).subsonic.title}`,
            });
            filteredSongs = results.map((result) => result.original);
        } else {
            filteredSongs = Songs;
        }

        for (const entry of filteredSongs) {
            if (skipped < songOffset) {
                skipped++;
                continue; // Skip items until offset is reached
            }
            songs.push(entry);
            if (songs.length >= songCount) break; // Stop after collecting `limit` items
        }

        for (const result of songs) {
            const track = result.value as Song;
            const userData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
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
