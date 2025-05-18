import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts'; // Added appConfig
import { Album, ArtistSchema, Song } from '../../zod.ts'; // ArtistInfoSchema
import { getArtistIDByName } from '../../MediaScanner.ts';

const getArtistInfo = new Hono();

// Re-use the helper function from getAlbumInfo.ts or define it locally
function formatCoverUrl(c: Context, relativeUrl?: string): string | undefined {
    if (!relativeUrl) return undefined;
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    return `${baseUrl}${relativeUrl}`;
}

async function handleGetArtistInfo(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id') || ''; // Can be artist, album, or song ID
    const _count = parseInt(await getField(c, 'count') || '20'); // Not used for main artist info
    const includeNotPresent = await getField(c, 'includeNotPresent');

    if (includeNotPresent === 'true') return createResponse(c, {}, 'failed', { code: 0, message: "Parameter 'includeNotPresent' not implemented" });
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    // Determine the actual artist ID based on the provided ID type
    let artistIdToFetch: string | undefined = id; // Assume it's an artist ID first
    const artistEntry = await database.get(['artists', artistIdToFetch]);

    if (!artistEntry.value) { // If not a direct artist ID, try to find from album/song
        const album = (await database.get(['albums', id])).value as Album | null;
        if (album && album.subsonic.artists && album.subsonic.artists.length > 0) {
            artistIdToFetch = album.subsonic.artists[0].id;
        } else {
            const track = (await database.get(['tracks', id])).value as Song | null;
            if (track && track.subsonic.artists && track.subsonic.artists.length > 0) {
                artistIdToFetch = track.subsonic.artists[0].id;
            } else {
                // If still not found, it might be an artist name if getArtistIDByName was intended here
                // but the flow implies 'id' is a db id.
                artistIdToFetch = await getArtistIDByName(id); // Last attempt to resolve by name
                if (!artistIdToFetch) {
                    return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found based on provided ID.' });
                }
            }
        }
    }

    const finalArtistEntry = await database.get(['artists', artistIdToFetch as string]);
    if (!finalArtistEntry.value) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found.' });
    }

    const artist = ArtistSchema.parse(finalArtistEntry.value);

    let artistInfoResponse: Record<string, unknown> = {};

    if (artist.artistInfo) {
        const infoCopy = { ...artist.artistInfo }; // Create a copy

        // Prepend base URL to image URLs
        infoCopy.smallImageUrl = formatCoverUrl(c, artist.artistInfo.smallImageUrl);
        infoCopy.mediumImageUrl = formatCoverUrl(c, artist.artistInfo.mediumImageUrl);
        infoCopy.largeImageUrl = formatCoverUrl(c, artist.artistInfo.largeImageUrl);

        // Process similarArtist array to create ArtistID3-like objects
        const similarArtistDetails = [];
        if (Array.isArray(infoCopy.similarArtist)) {
            for (const artistName of infoCopy.similarArtist as string[]) { // Cast as similarArtist is string[] in schema
                const similarArtistId = await getArtistIDByName(artistName);
                if (similarArtistId) {
                    const simArtistEntry = await database.get(['artists', similarArtistId]);
                    if (simArtistEntry.value) {
                        const simArtist = ArtistSchema.parse(simArtistEntry.value);
                        similarArtistDetails.push({
                            id: simArtist.artist.id,
                            name: simArtist.artist.name,
                            coverArt: simArtist.artist.coverArt, // This will be the artistID
                            artistImageUrl: formatCoverUrl(
                                c,
                                simArtist.artistInfo?.largeImageUrl || simArtist.artistInfo?.mediumImageUrl || simArtist.artistInfo?.smallImageUrl,
                            ),
                            albumCount: simArtist.artist.albumCount,
                        });
                    }
                }
            }
        }
        // Replace the string array with the detailed objects
        // Subsonic API expects 'similarArtist' to contain <artist> elements
        // deno-lint-ignore no-explicit-any
        infoCopy.similarArtist = similarArtistDetails as any; // Cast to any to fit schema, XML output will handle structure

        artistInfoResponse = infoCopy;
    } else {
        // If artistInfo is empty/null, Subsonic often expects an empty tag or specific structure.
        // For now, returning an empty object for artistInfo if it's not present in DB.
        // The createResponse function will wrap this.
    }

    return createResponse(c, {
        [/(getArtistInfo2|getArtistInfo2\.view)$/.test(c.req.path) ? 'artistInfo2' : 'artistInfo']: artistInfoResponse,
    }, 'ok');
}

// getArtistIDByAlbumOrSongID was previously here, now integrated into handleGetArtistInfo
// async function getArtistIDByAlbumOrSongID(id: string) { /* ... */ }

getArtistInfo.get('/getArtistInfo', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo', handleGetArtistInfo);
getArtistInfo.get('/getArtistInfo.view', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo.view', handleGetArtistInfo);

getArtistInfo.get('/getArtistInfo2', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo2', handleGetArtistInfo);
getArtistInfo.get('/getArtistInfo2.view', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo2.view', handleGetArtistInfo);

export default getArtistInfo;
