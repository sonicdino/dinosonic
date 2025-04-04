import { Context, Hono } from 'hono';
import { createResponse, database, getUserByUsername, validateAuth } from '../../util.ts';
import { Artist, ArtistID3, userData } from '../../zod.ts';

const getArtists = new Hono();

async function handlegetArtists(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const artists = [];

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    for await (const entry of database.list({ prefix: ['artists'] })) {
        const artist = entry.value as Artist;
        const artistId = artist.artist.id;

        const userData = (await database.get(['userData', user.backend.id, 'artist', artistId])).value as userData | undefined;
        if (userData) {
            if (userData.starred) artist.artist.starred = userData.starred.toISOString();
            if (userData.userRating) artist.artist.userRating = userData.userRating;
        }

        // @ts-expect-error A weird error with Deno type checking i guess.
        delete artist.artist.album;
        artists.push(artist.artist);
    }

    const groupedArtists: Record<string, ArtistID3[]> = {};

    for (const artist of artists) {
        const firstChar = artist.name[0].toUpperCase();
        const indexChar = /^[A-Z]$/.test(firstChar) ? firstChar : '#'; // Non-alphabetical as '#'

        if (!groupedArtists[indexChar]) {
            groupedArtists[indexChar] = [];
        }

        groupedArtists[indexChar].push(artist);
    }

    for (const key in groupedArtists) {
        groupedArtists[key].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    const sortedIndexList = Object.entries(groupedArtists)
        .sort(([a], [b]) => a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b))
        .map(([key, value]) => ({
            name: key,
            artist: value,
        }));

    return createResponse(c, {
        artists: { index: sortedIndexList },
    }, 'ok');
}

getArtists.get('/getArtists', handlegetArtists);
getArtists.post('/getArtists', handlegetArtists);
getArtists.get('/getArtists.view', handlegetArtists);
getArtists.post('/getArtists.view', handlegetArtists);

export default getArtists;
