import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Album, Artist, Song } from '../../zod.ts';

const getArtistInfo = new Hono();

async function handlegetArtistInfo(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    let id = await getField(c, 'id') || '';
    const _count = parseInt(await getField(c, 'count') || '20');
    const includeNotPresent = await getField(c, 'includeNotPresent');

    if (includeNotPresent === 'true') return createResponse(c, {}, 'failed', { code: 0, message: "Parameter 'includeNotPresent' not implemented" });
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    if (id.startsWith('a') || id.startsWith('t')) id = await getArtistIDByAlbumOrSongID(id);
    const artist = (await database.get(['artists', id])).value as Artist | undefined;
    if (!artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found' });

    return createResponse(c, {
        [c.req.path === '/rest/getArtistInfo' ? 'artistInfo' : 'artistInfo2']: artist.artistInfo,
    }, 'ok');
}

async function getArtistIDByAlbumOrSongID(id: string) {
    if (id.startsWith('a')) {
        const album = (await database.get(['albums', id])).value as Album | null;
        if (!album) return '';
        return album.subsonic.artists[0].id;
    }

    const track = (await database.get(['tracks', id])).value as Song | null;
    if (!track) return '';
    return track.subsonic.artists[0].id;
}

getArtistInfo.get('/getArtistInfo', handlegetArtistInfo);
getArtistInfo.post('/getArtistInfo', handlegetArtistInfo);
getArtistInfo.get('/getArtistInfo.view', handlegetArtistInfo);
getArtistInfo.post('/getArtistInfo.view', handlegetArtistInfo);

getArtistInfo.get('/getArtistInfo2', handlegetArtistInfo);
getArtistInfo.post('/getArtistInfo2', handlegetArtistInfo);
getArtistInfo.get('/getArtistInfo2.view', handlegetArtistInfo);
getArtistInfo.post('/getArtistInfo2.view', handlegetArtistInfo);

export default getArtistInfo;
