import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { AlbumID3, AlbumSchema, ArtistID3, ArtistSchema, userData } from '../../zod.ts'; // ArtistSchema for parsing

function formatFullUrl(c: Context, relativeUrl?: string): string | undefined {
    if (!relativeUrl) return undefined;
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    return `${baseUrl}${relativeUrl}`;
}

const getArtist = new Hono();

async function handleGetArtist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artistId = await getField(c, 'id') || '';

    if (!artistId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const artistEntry = await database.get(['artists', artistId]);
    if (!artistEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found' });

    const parsedArtist = ArtistSchema.safeParse(artistEntry.value);
    if (!parsedArtist.success) {
        return createResponse(c, {}, 'failed', { code: 0, message: 'Malformed artist data in database.' });
    }
    const artistData = parsedArtist.data; // This is the full Artist object (includes artistInfo)

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const artistResponse: ArtistID3 = { ...artistData.artist }; // Start with the ArtistID3 part

    const userArtistData = (await database.get(['userData', user.backend.id, 'artist', artistId])).value as userData | undefined;
    if (userArtistData) {
        if (userArtistData.starred) artistResponse.starred = userArtistData.starred.toISOString();
        if (userArtistData.userRating) artistResponse.userRating = userArtistData.userRating;
    }

    artistResponse.artistImageUrl = formatFullUrl(c, artistData.artist.artistImageUrl);

    const responseAlbums: AlbumID3[] = [];
    if (Array.isArray(artistData.artist.album)) {
        for (const albumIdOrObject of artistData.artist.album) {
            const albumId = typeof albumIdOrObject === 'string' ? albumIdOrObject : (albumIdOrObject as AlbumID3).id;
            const albumEntry = await database.get(['albums', albumId]);
            if (albumEntry.value) {
                const parsedAlbum = AlbumSchema.safeParse(albumEntry.value);
                if (parsedAlbum.success) {
                    const albumSubsonic = parsedAlbum.data.subsonic;
                    // @ts-expect-error Subsonic API for getArtist doesn't want songs in album objects
                    delete albumSubsonic.song;

                    const userAlbumData = (await database.get(['userData', user.backend.id, 'album', albumSubsonic.id])).value as
                        | userData
                        | undefined;
                    if (userAlbumData) {
                        if (userAlbumData.starred) albumSubsonic.starred = userAlbumData.starred.toISOString();
                        if (userAlbumData.played) albumSubsonic.played = userAlbumData.played.toISOString();
                        if (userAlbumData.playCount) albumSubsonic.playCount = userAlbumData.playCount;
                        if (userAlbumData.userRating) albumSubsonic.userRating = userAlbumData.userRating;
                    }

                    responseAlbums.push(albumSubsonic);
                }
            }
        }
    }
    artistResponse.album = responseAlbums.sort((a, b) => {
        const numA = parseInt(a.id.replace(/[^0-9]/g, ''), 10) || 0;
        const numB = parseInt(b.id.replace(/[^0-9]/g, ''), 10) || 0;
        if (numA !== numB) return numA - numB;
        return (a.year || 0) - (b.year || 0) || a.name.localeCompare(b.name); // Fallback sort
    });

    return createResponse(c, {
        artist: artistResponse,
    }, 'ok');
}

getArtist.get('/getArtist', handleGetArtist);
getArtist.post('/getArtist', handleGetArtist);
getArtist.get('/getArtist.view', handleGetArtist);
getArtist.post('/getArtist.view', handleGetArtist);

export default getArtist;
