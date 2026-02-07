import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Song, userData } from '../../zod.ts';

const getRandomSongs = new Hono();

async function handlegetRandomSongs(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const size = parseInt(await getField(c, 'size') || '10');
    const fromYear = parseInt(await getField(c, 'fromYear') || '0');
    const toYear = parseInt(await getField(c, 'toYear') || '0');
    const genre = await getField(c, 'genre');
    const musicFolderId = parseInt(await getField(c, 'musicFolderId') || '1');

    // Currently only one virtual music folder (id: 1) is supported
    if (musicFolderId !== 1) return createResponse(c, { randomSongs: [] }, 'ok');

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    let songs = (await Array.fromAsync(database.list({ prefix: ['tracks'] }))).map((Albums) => (Albums.value as Song));
    const song = [];

    if (fromYear && toYear) {
        songs = songs.filter((song) => (song.subsonic.year || 0) >= (fromYear || 0) && (song.subsonic.year || 0) <= (toYear || 0));
    }

    if (genre) {
        songs = songs.filter((song) => song.subsonic.genres?.some((Genre) => Genre.name === genre));
    }

    songs = songs.sort(() => Math.random() - 0.5).slice(0, size || 0);

    for (const track of songs) {
        const userData = (await database.get(['userData', user.backend.id, 'track', track.subsonic.id])).value as userData | undefined;
        if (userData) {
            if (userData.starred) track.subsonic.starred = userData.starred.toISOString();
            if (userData.played) track.subsonic.played = userData.played.toISOString();
            if (userData.playCount) track.subsonic.playCount = userData.playCount;
            if (userData.userRating) track.subsonic.userRating = userData.userRating;
        }

        song.push(track.subsonic);
    }

    return createResponse(c, {
        randomSongs: {
            song: song,
        },
    }, 'ok');
}

getRandomSongs.get('/getRandomSongs', handlegetRandomSongs);
getRandomSongs.post('/getRandomSongs', handlegetRandomSongs);
getRandomSongs.get('/getRandomSongs.view', handlegetRandomSongs);
getRandomSongs.post('/getRandomSongs.view', handlegetRandomSongs);

export default getRandomSongs;
