import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { AlbumSchema } from '../../zod.ts';
import { getCoverArtShareUrl } from '../../scanner/ShareManager.ts';

const getAlbumInfo = new Hono();

async function handleGetAlbumInfo(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id') || '';

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const albumEntry = await database.get(['albums', id]);
    if (!albumEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

    const album = AlbumSchema.parse(albumEntry.value);

    const coverArtId = album.subsonic.coverArt || id;
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;
    const description = `Cover art for ${album.subsonic.name}`;

    const albumInfoResponse: Record<string, unknown> = {
        notes: album.albumInfo?.notes || '',
        musicBrainzId: album.subsonic.musicBrainzId || album.albumInfo?.musicBrainzId,
        lastFmUrl: album.albumInfo?.lastFmUrl,
        smallImageUrl: await getCoverArtShareUrl(coverArtId, 300, baseUrl, description),
        mediumImageUrl: await getCoverArtShareUrl(coverArtId, 600, baseUrl, description),
        largeImageUrl: await getCoverArtShareUrl(coverArtId, 1200, baseUrl, description),
    };

    return createResponse(c, { albumInfo: albumInfoResponse }, 'ok');
}

getAlbumInfo.get('/getAlbumInfo', handleGetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo', handleGetAlbumInfo);
getAlbumInfo.get('/getAlbumInfo.view', handleGetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo.view', handleGetAlbumInfo);

getAlbumInfo.get('/getAlbumInfo2', handleGetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo2', handleGetAlbumInfo);
getAlbumInfo.get('/getAlbumInfo2.view', handleGetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo2.view', handleGetAlbumInfo);

export default getAlbumInfo;
