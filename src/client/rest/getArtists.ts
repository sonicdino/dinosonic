import { Context, Hono } from '@hono/hono';
import { createResponse, database, getUserByUsername, logger, validateAuth } from '../../util.ts';
import { ArtistID3, ArtistSchema, userData } from '../../zod.ts'; // ArtistSchema

function formatFullUrl(c: Context, relativeUrl?: string): string | undefined {
    if (!relativeUrl) return undefined;
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    return `${baseUrl}${relativeUrl}`;
}

const getArtists = new Hono();

async function handleGetArtists(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artistsResponseList: ArtistID3[] = [];

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    for await (const entry of database.list({ prefix: ['artists'] })) {
        const parsedArtist = ArtistSchema.safeParse(entry.value);
        if (!parsedArtist.success) {
            logger.warn(`Malformed artist data in DB for getArtists: ${entry.key.join('/')}`);
            continue;
        }
        const artistData = parsedArtist.data; // Full Artist object
        const artistForResponse: ArtistID3 = { ...artistData.artist }; // Start with ArtistID3 part

        const userArtistData = (await database.get(['userData', user.backend.id, 'artist', artistForResponse.id])).value as userData | undefined;
        if (userArtistData) {
            if (userArtistData.starred) artistForResponse.starred = userArtistData.starred.toISOString();
            if (userArtistData.userRating) artistForResponse.userRating = userArtistData.userRating;
        }

        // artistData.artist.artistImageUrl should be the relative proxied path from MediaScanner
        artistForResponse.artistImageUrl = formatFullUrl(c, artistData.artist.artistImageUrl);

        // @ts-expect-error For getArtists, album list is usually not populated or is minimal.
        delete artistForResponse.album;

        artistsResponseList.push(artistForResponse);
    }

    const groupedArtists: Record<string, ArtistID3[]> = {};
    for (const artist of artistsResponseList) {
        const firstChar = artist.name[0].toUpperCase();
        const indexChar = /^[A-Z]$/.test(firstChar) ? firstChar : '#';
        if (!groupedArtists[indexChar]) {
            groupedArtists[indexChar] = [];
        }
        groupedArtists[indexChar].push(artist);
    }

    for (const key in groupedArtists) {
        groupedArtists[key].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    const sortedIndexList = Object.entries(groupedArtists)
        .sort(([aKey], [bKey]) => (aKey === '#' ? 1 : bKey === '#' ? -1 : aKey.localeCompare(bKey))) // Ensure '#' is last
        .map(([key, value]) => ({
            name: key,
            artist: value, // value is already Array<ArtistID3>
        }));

    return createResponse(c, {
        artists: { ignoredArticles: '', index: sortedIndexList },
    }, 'ok');
}

getArtists.get('/getArtists', handleGetArtists);
getArtists.post('/getArtists', handleGetArtists);
getArtists.get('/getArtists.view', handleGetArtists);
getArtists.post('/getArtists.view', handleGetArtists);

export default getArtists;
