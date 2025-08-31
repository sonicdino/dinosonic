import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts'; // Added appConfig
import { AlbumSchema } from '../../zod.ts'; // AlbumInfoSchema for potential validation if needed

const getAlbumInfo = new Hono();

function formatCoverUrl(c: Context, relativeUrl?: string): string | undefined {
    if (!relativeUrl) return undefined;
    // Construct base URL dynamically from the request, or use a configured one
    // For simplicity, let's assume HTTP for now. If HTTPS is configured, that should be used.
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`; // More reliable way to get base URL
    return `${baseUrl}${relativeUrl}`;
}

async function handleGetAlbumInfo(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id') || '';

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const albumEntry = await database.get(['albums', id]);
    if (!albumEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

    const album = AlbumSchema.parse(albumEntry.value); // Ensure it's parsed against the schema

    let albumInfoResponse: Record<string, unknown> = {};

    if (album.albumInfo) {
        // Create a copy to modify URLs without affecting the stored data
        const infoCopy = { ...album.albumInfo };

        // Prepend base URL to image URLs
        infoCopy.smallImageUrl = formatCoverUrl(c, album.albumInfo.smallImageUrl);
        infoCopy.mediumImageUrl = formatCoverUrl(c, album.albumInfo.mediumImageUrl);
        infoCopy.largeImageUrl = formatCoverUrl(c, album.albumInfo.largeImageUrl);

        albumInfoResponse = infoCopy;
    }

    return createResponse(c, { albumInfo: albumInfoResponse, }, 'ok');
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
