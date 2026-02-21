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
        if (!song) continue;

        const trackUserData = (await database.get(['userData', user.backend.id, 'track', trackId as string])).value as userData | undefined;
        if (trackUserData) {
            if (trackUserData.starred) song.subsonic.starred = trackUserData.starred.toISOString();
            if (trackUserData.played) song.subsonic.played = trackUserData.played.toISOString();
            if (trackUserData.playCount) song.subsonic.playCount = trackUserData.playCount;
            if (trackUserData.userRating) song.subsonic.userRating = trackUserData.userRating;
        }
        entry.push(song.subsonic);
    }

    return createResponse(c, {
        playQueue: {
            current: playQueue.current,
            position: playQueue.position,
            username: playQueue.username,
            changed: playQueue.changed,
            changedBy: playQueue.changedBy,
            entry,
        },
    }, 'ok');
}

getPlayQueue.get('/getPlayQueue', handlegetPlayQueue);
getPlayQueue.post('/getPlayQueue', handlegetPlayQueue);
getPlayQueue.get('/getPlayQueue.view', handlegetPlayQueue);
getPlayQueue.post('/getPlayQueue.view', handlegetPlayQueue);

export default getPlayQueue;
