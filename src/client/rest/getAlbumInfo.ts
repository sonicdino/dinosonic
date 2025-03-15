import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Album } from '../../zod.ts';

const getAlbumInfo = new Hono();

async function handlegetAlbumInfo(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id') || '';

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const album = (await database.get(['albums', id])).value as Album | undefined;
    if (!album) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

    return createResponse(c, {
        albumInfo: album.albumInfo || {},
    }, 'ok');
}

getAlbumInfo.get('/getAlbumInfo', handlegetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo', handlegetAlbumInfo);
getAlbumInfo.get('/getAlbumInfo.view', handlegetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo.view', handlegetAlbumInfo);

getAlbumInfo.get('/getAlbumInfo2', handlegetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo2', handlegetAlbumInfo);
getAlbumInfo.get('/getAlbumInfo2.view', handlegetAlbumInfo);
getAlbumInfo.post('/getAlbumInfo2.view', handlegetAlbumInfo);

export default getAlbumInfo;
