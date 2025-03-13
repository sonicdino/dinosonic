import { Context, Hono } from 'hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { Album, userData } from '../../zod.ts';

const getAlbumList = new Hono();

async function handlegetAlbumList(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const type = c.req.query('type');
    const size = parseInt(c.req.query('size') || '10');
    const offset = parseInt(c.req.query('offset') || '0');
    const fromYear = parseInt(c.req.query('fromYear') || '0');
    const toYear = parseInt(c.req.query('toYear') || '0');
    const genre = c.req.query('genre');

    if (!type) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'type'" });
    if ((type === 'byYear' && !fromYear)) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'fromYear'" });
    if ((type === 'byYear' && !toYear)) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'toYear'" });
    if (type === 'byGenre' && !genre) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'genre'" });

    let Albums = (await Array.fromAsync(database.list({ prefix: ['albums'] }))).map((Albums) => (Albums.value as Album));
    const album = [];

    switch (type) {
        case 'random':
            Albums = Albums.sort(() => Math.random() - 0.5);
            break;

        case 'newest':
            Albums = Albums.sort((a, b) => (b.subsonic.year || 0) - (a.subsonic.year || 0));
            break;

        case 'alphabeticalByName': {
            Albums = Albums.sort((a, b) => a.subsonic.name.localeCompare(b.subsonic.name, undefined, { sensitivity: 'base' }));
            break;
        }

        case 'highest': {
            const userDatas = (await Array.fromAsync(database.list({ prefix: ['userData', 'admin', 'album'] }))).map(
                (entry) => (entry.value as userData),
            );
            const userRatings = new Map(userDatas.map((entry) => [entry.id, entry.userRating]));
            Albums = Albums.map((album) => ({
                ...album,
                rating: userRatings.get(album.subsonic.id) || 0, // Default to 0 if no rating is found
            })).sort((a, b) => b.rating - a.rating);
            break;
        }

        case 'frequent': {
            const userDatas = (await Array.fromAsync(database.list({ prefix: ['userData', 'admin', 'album'] }))).map(
                (entry) => (entry.value as userData),
            );
            const userPlaycount = new Map(userDatas.map((entry) => [entry.id, entry.playCount]));
            Albums = Albums.map((album) => ({
                ...album,
                playCount: userPlaycount.get(album.subsonic.id) || 0, // Default to 0 if no rating is found
            })).sort((a, b) => b.playCount - a.playCount);
            break;
        }

        case 'recent':
            Albums = Albums.sort((a, b) => b.backend.dateAdded - a.backend.dateAdded);
            break;

        case 'byYear':
            Albums = Albums.filter((album) => (album.subsonic.year || 0) >= (fromYear || 0) && (album.subsonic.year || 0) <= (toYear || 0));
            break;

        case 'byGenre':
            Albums = Albums.filter((album) => album.subsonic.genres?.some((Genre) => Genre.name === genre));
            break;

        default:
            return createResponse(c, {}, 'failed', { code: 0, message: `Type '${type}' not implemented.` });
    }

    Albums = Albums.slice(offset, offset + size || 0);

    for (const Album of Albums) {
        // @ts-expect-error A weird error with Deno type checking i guess.
        delete Album.subsonic.song;

        const userData = (await database.get(['userData', isValidated.username, 'album', Album.subsonic.id])).value as userData | undefined;
        if (userData) {
            if (userData.starred) Album.subsonic.starred = userData.starred.toISOString();
            if (userData.played) Album.subsonic.played = userData.played.toISOString();
            if (userData.playCount) Album.subsonic.playCount = userData.playCount;
            if (userData.userRating) Album.subsonic.userRating = userData.userRating;
        }

        album.push(Album.subsonic);
    }

    return createResponse(c, {
        [c.req.path === '/rest/getAlbumList' ? 'albumList' : 'albumList2']: {
            album: album,
        },
    }, 'ok');
}

getAlbumList.get('/getAlbumList', handlegetAlbumList);
getAlbumList.post('/getAlbumList', handlegetAlbumList);
getAlbumList.get('/getAlbumList.view', handlegetAlbumList);
getAlbumList.post('/getAlbumList.view', handlegetAlbumList);

getAlbumList.get('/getAlbumList2', handlegetAlbumList);
getAlbumList.post('/getAlbumList2', handlegetAlbumList);
getAlbumList.get('/getAlbumList2.view', handlegetAlbumList);
getAlbumList.post('/getAlbumList2.view', handlegetAlbumList);

export default getAlbumList;
