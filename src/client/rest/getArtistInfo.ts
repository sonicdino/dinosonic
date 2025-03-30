import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Album, Artist, ArtistID3, Song, userData } from '../../zod.ts';
import { getArtistIDByName } from '../../MediaScanner.ts';

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
    if (!artist.artistInfo) return createResponse(c, {}, 'ok');
    const similarArtist: ArtistID3[] = [];

    for (const artistName of artist.artistInfo.similarArtist) {
        const artistId = await getArtistIDByName(artistName);
        if (!artistId) continue;

        const Artist = (await database.get(['artists', artistId as string])).value as Artist | undefined;
        if (!Artist) continue;

        const userData = (await database.get(['userData', isValidated.username, 'artist', artistId as string])).value as userData | undefined;
        if (userData) {
            if (userData.starred) Artist.artist.starred = userData.starred.toISOString();
            if (userData.userRating) Artist.artist.userRating = userData.userRating;
        }

        // @ts-expect-error A weird error with Deno type checking i guess.
        delete Artist.artist.album;

        similarArtist.push(Artist.artist);
    }

    return createResponse(c, {
        [/(getArtistInfo2|getArtistInfo2\.view)$/.test(c.req.path) ? 'artistInfo2' : 'artistInfo']: { ...artist.artistInfo, similarArtist },
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
