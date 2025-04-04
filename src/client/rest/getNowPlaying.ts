import { Context, Hono } from 'hono';
import { createResponse, database, getUserByUsername, validateAuth } from '../../util.ts';
import { nowPlaying, userData } from '../../zod.ts';

const getNowPlaying = new Hono();

async function handlegetNowPlaying(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const entries = [];

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    let i = 0;
    for await (const entry of database.list({ prefix: ['nowPlaying'] })) {
        const item = entry.value as nowPlaying;
        const song = item.track;
        const userData = (await database.get(['userData', user.backend.id, 'track', song.id])).value as userData | undefined;
        if (userData) {
            if (userData.starred) song.starred = userData.starred.toISOString();
            if (userData.played) song.played = userData.played.toISOString();
            if (userData.playCount) song.playCount = userData.playCount;
            if (userData.userRating) song.userRating = userData.userRating;
        }

        entries.push({
            ...song,
            minutesAgo: Math.floor((Date.now() - item.minutesAgo.getTime()) / (1000 * 60)),
            playerName: item.playerName,
            playerId: i++,
        });
    }

    return createResponse(c, { nowPlaying: { entry: entries } }, 'ok');
}

getNowPlaying.get('/getNowPlaying', handlegetNowPlaying);
getNowPlaying.post('/getNowPlaying', handlegetNowPlaying);
getNowPlaying.get('/getNowPlaying.view', handlegetNowPlaying);
getNowPlaying.post('/getNowPlaying.view', handlegetNowPlaying);

export default getNowPlaying;
