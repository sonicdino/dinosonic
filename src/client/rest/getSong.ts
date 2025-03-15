import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Song, userData } from '../../zod.ts';

const getSong = new Hono();

async function handlegetSong(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const trackId = await getField(c, 'id') || '';

    if (!trackId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const song = (await database.get(['tracks', trackId])).value as Song | undefined;
    if (!song) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    const userData = (await database.get(['userData', isValidated.username, 'track', trackId])).value as userData | undefined;
    if (userData) {
        if (userData.starred) song.subsonic.starred = userData.starred.toISOString();
        if (userData.played) song.subsonic.played = userData.played.toISOString();
        if (userData.playCount) song.subsonic.playCount = userData.playCount;
        if (userData.userRating) song.subsonic.userRating = userData.userRating;
    }

    return createResponse(c, {
        song: song.subsonic,
    }, 'ok');
}

getSong.get('/getSong', handlegetSong);
getSong.post('/getSong', handlegetSong);
getSong.get('/getSong.view', handlegetSong);
getSong.post('/getSong.view', handlegetSong);

export default getSong;
