import { Context, Hono } from '@hono/hono';
import { createResponse, database, getUserByUsername, validateAuth } from '../../util.ts';
import { PlayQueueByIndex, PlayQueueByIndexSchema, Song, SongID3, userData } from '../../zod.ts';

const getPlayQueueByIndex = new Hono();

async function handlegetPlayQueueByIndex(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const playQueue = (await database.get(['playQueueByIndex', user.backend.id])).value as PlayQueueByIndex | undefined;
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

    // Create and validate response using the schema
    const playQueueByIndex = PlayQueueByIndexSchema.safeParse({
        currentIndex: playQueue.currentIndex || 0,
        position: playQueue.position,
        username: playQueue.username,
        changed: playQueue.changed,
        changedBy: playQueue.changedBy,
        entry
    });

    if (!playQueueByIndex.success) {
        return createResponse(c, {}, 'failed', { code: 10, message: 'Failed to create play queue response' });
    }

    return createResponse(c, { playQueueByIndex: playQueueByIndex.data }, 'ok');
}

getPlayQueueByIndex.get('/getPlayQueueByIndex', handlegetPlayQueueByIndex);
getPlayQueueByIndex.post('/getPlayQueueByIndex', handlegetPlayQueueByIndex);
getPlayQueueByIndex.get('/getPlayQueueByIndex.view', handlegetPlayQueueByIndex);
getPlayQueueByIndex.post('/getPlayQueueByIndex.view', handlegetPlayQueueByIndex);

export default getPlayQueueByIndex;
