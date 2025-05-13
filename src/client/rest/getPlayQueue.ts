import { Context, Hono } from '@hono/hono';
import { createResponse, database, getUserByUsername, validateAuth } from '../../util.ts';
import { PlayQueue, Song, SongID3, userData } from '../../zod.ts';

const getPlayQueue = new Hono();

async function handlegetPlayQueue(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const playQueue = (await database.get(['playQueue', user.backend.id])).value as PlayQueue | undefined;
    if (!playQueue) return createResponse(c, {}, 'ok');
    const entry: SongID3[] = [];

    for (const trackId of playQueue.entry || []) {
        const song = (await database.get(['tracks', trackId as string])).value as Song | undefined;
        if (!song) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

        const userData = (await database.get(['userData', user.backend.id, 'track', trackId as string])).value as userData | undefined;
        if (userData) {
            if (userData.starred) song.subsonic.starred = userData.starred.toISOString();
            if (userData.played) song.subsonic.played = userData.played.toISOString();
            if (userData.playCount) song.subsonic.playCount = userData.playCount;
            if (userData.userRating) song.subsonic.userRating = userData.userRating;
        }
        entry.push(song.subsonic);
    }

    return createResponse(c, { playQueue: { ...playQueue, entry } }, 'ok');
}

getPlayQueue.get('/getPlayQueue', handlegetPlayQueue);
getPlayQueue.post('/getPlayQueue', handlegetPlayQueue);
getPlayQueue.get('/getPlayQueue.view', handlegetPlayQueue);
getPlayQueue.post('/getPlayQueue.view', handlegetPlayQueue);

export default getPlayQueue;
