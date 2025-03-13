import { Context, Hono } from 'hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { Song, userData } from '../../zod.ts';

const getRandomSongs = new Hono();

async function handlegetRandomSongs(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const size = parseInt(c.req.query('size') || '10');
    const fromYear = parseInt(c.req.query('fromYear') || '0');
    const toYear = parseInt(c.req.query('toYear') || '0');
    const genre = c.req.query('genre');

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
        const userData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
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
