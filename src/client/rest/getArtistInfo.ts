import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Album, ArtistSchema, Song } from '../../zod.ts';
import { getArtistIDByName } from '../../MediaScanner.ts';
import { getCoverArtShareUrl } from '../../scanner/ShareManager.ts';

const getArtistInfo = new Hono();

async function handleGetArtistInfo(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id') || '';
    const _count = parseInt(await getField(c, 'count') || '20');
    const includeNotPresent = await getField(c, 'includeNotPresent');

    if (includeNotPresent === 'true') return createResponse(c, {}, 'failed', { code: 0, message: "Parameter 'includeNotPresent' not implemented" });
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    let artistIdToFetch: string | undefined = id;
    const artistEntry = await database.get(['artists', artistIdToFetch]);

    if (!artistEntry.value) {
        const album = (await database.get(['albums', id])).value as Album | null;
        if (album && album.subsonic.artists && album.subsonic.artists.length > 0) {
            artistIdToFetch = album.subsonic.artists[0].id;
        } else {
            const track = (await database.get(['tracks', id])).value as Song | null;
            if (track && track.subsonic.artists && track.subsonic.artists.length > 0) {
                artistIdToFetch = track.subsonic.artists[0].id;
            } else {
                artistIdToFetch = await getArtistIDByName(id);
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

    const coverArtId = artist.artist.coverArt || artist.artist.id;
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    const description = `Cover art for ${artist.artist.name}`;

    const artistInfoResponse: Record<string, unknown> = {
        biography: artist.artistInfo?.biography || '',
        musicBrainzId: artist.artist.musicBrainzId || artist.artistInfo?.musicBrainzId,
        lastFmUrl: artist.artistInfo?.lastFmUrl,
        smallImageUrl: await getCoverArtShareUrl(coverArtId, 300, baseUrl, description),
        mediumImageUrl: await getCoverArtShareUrl(coverArtId, 600, baseUrl, description),
        largeImageUrl: await getCoverArtShareUrl(coverArtId, 1200, baseUrl, description),
        similarArtist: [],
    };

    const similarArtistDetails = [];
    if (artist.artistInfo?.similarArtist && Array.isArray(artist.artistInfo.similarArtist)) {
        for (const artistName of artist.artistInfo.similarArtist as string[]) {
            const similarArtistId = await getArtistIDByName(artistName);
            if (similarArtistId) {
                const simArtistEntry = await database.get(['artists', similarArtistId]);
                if (simArtistEntry.value) {
                    const simArtist = ArtistSchema.parse(simArtistEntry.value);
                    const simCoverArtId = simArtist.artist.coverArt || simArtist.artist.id;
                    similarArtistDetails.push({
                        id: simArtist.artist.id,
                        name: simArtist.artist.name,
                        coverArt: simArtist.artist.coverArt,
                        artistImageUrl: await getCoverArtShareUrl(simCoverArtId, 600, baseUrl, `Cover art for ${simArtist.artist.name}`),
                        albumCount: simArtist.artist.albumCount,
                    });
                }
            }
        }
    }
    // deno-lint-ignore no-explicit-any
    artistInfoResponse.similarArtist = similarArtistDetails as any;

    return createResponse(c, {
        [/(getArtistInfo2|getArtistInfo2\.view)$/.test(c.req.path) ? 'artistInfo2' : 'artistInfo']: artistInfoResponse,
    }, 'ok');
}

getArtistInfo.get('/getArtistInfo', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo', handleGetArtistInfo);
getArtistInfo.get('/getArtistInfo.view', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo.view', handleGetArtistInfo);

getArtistInfo.get('/getArtistInfo2', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo2', handleGetArtistInfo);
getArtistInfo.get('/getArtistInfo2.view', handleGetArtistInfo);
getArtistInfo.post('/getArtistInfo2.view', handleGetArtistInfo);

export default getArtistInfo;
