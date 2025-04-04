import { Context, Hono } from 'hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Song, SongID3, userData } from '../../zod.ts';

const getSimilarSongs = new Hono();

async function handlegetSimilarSongs(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const count = parseInt(await getField(c, 'count') || '50');
    const trackId = await getField(c, 'id') || '';

    if (!trackId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const song = (await database.get(['tracks', trackId])).value as Song | undefined;
    if (!song) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const baseUserData = await getUserTrackData(user.backend.id, song.subsonic.id);
    if (baseUserData) {
        if (baseUserData.starred) song.subsonic.starred = baseUserData.starred.toISOString();
        if (baseUserData.playCount) song.subsonic.playCount = baseUserData.playCount;
        if (baseUserData.userRating) song.subsonic.userRating = baseUserData.userRating;
    }

    const scoredSongs = await Promise.all(
        (await Array.fromAsync(database.list({ prefix: ['tracks'] })))
            .filter((entry) => (entry.value as Song).subsonic.id !== song.subsonic.id)
            .map(async (candidate) => {
                const trackCanditate = (candidate.value as Song).subsonic;
                const candidateUserData = await getUserTrackData(user.backend.id, trackCanditate.id);
                if (candidateUserData) {
                    if (candidateUserData.starred) song.subsonic.starred = candidateUserData.starred.toISOString();
                    if (candidateUserData.playCount) song.subsonic.playCount = candidateUserData.playCount;
                    if (candidateUserData.userRating) song.subsonic.userRating = candidateUserData.userRating;
                }
                const score = calculateSimilarity(song.subsonic, trackCanditate);
                return { song: trackCanditate, score };
            }),
    );

    return createResponse(c, {
        [/(getSimilarSongs2|getSimilarSongs2\.view)$/.test(c.req.path) ? 'similarSongs2' : 'similarSongs']: {
            // I really don't know why I bothered to sort by score when I was just going to shuffle it anyway, but whatever.
            song: shuffleArray(scoredSongs.filter((item) => item.score > 0).sort((a, b) => b.score - a.score))
                .slice(0, count)
                .map((item) => item.song),
        },
    }, 'ok');
}

async function getUserTrackData(id: string, trackId: string) {
    return ((await database.get(['userData', id, 'track', trackId])).value as userData) || {};
}

function shuffleArray<T>(array: T[]): T[] {
    return array
        .map((item) => ({ item, rand: Math.random() })) // Assign random values
        .sort((a, b) => a.rand - b.rand) // Sort by random values
        .map(({ item }) => item); // Extract items
}

function calculateSimilarity(baseSong: SongID3, candidate: SongID3) {
    let score = 0;

    if (baseSong.genre && candidate.genre === baseSong.genre) score += 15;
    if (baseSong.artists.some((a) => candidate.artists.includes(a))) score += 10;
    if (baseSong.albumId && candidate.albumId === baseSong.albumId) score += 5;
    if (baseSong.bpm && candidate.bpm && Math.abs(baseSong.bpm - candidate.bpm) <= 10) score += 10;
    if (baseSong.year && candidate.year && Math.abs(baseSong.year - candidate.year) <= 5) score += 5;
    if (baseSong?.starred && candidate?.starred) score += 20;
    if (baseSong?.playCount && candidate?.playCount) {
        const playDiff = Math.abs(baseSong.playCount - candidate.playCount);
        score += Math.max(0, 20 - (playDiff / 10));
    }
    if (baseSong?.userRating && candidate?.userRating && Math.abs(baseSong.userRating - candidate.userRating) <= 1) {
        score += 15;
    }

    return score;
}

getSimilarSongs.get('/getSimilarSongs', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs', handlegetSimilarSongs);
getSimilarSongs.get('/getSimilarSongs.view', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs.view', handlegetSimilarSongs);

getSimilarSongs.get('/getSimilarSongs2', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs2', handlegetSimilarSongs);
getSimilarSongs.get('/getSimilarSongs2.view', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs2.view', handlegetSimilarSongs);

export default getSimilarSongs;
