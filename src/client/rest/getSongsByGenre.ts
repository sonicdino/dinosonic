import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Song, userData } from '../../zod.ts';

const getSongsByGenre = new Hono();

async function handlegetSongsByGenre(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    let count = parseInt(await getField(c, 'count') || '0');
    const offset = parseInt(await getField(c, 'offset') || '0');
    const genre = await getField(c, 'genre');

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    if (count > 500) count = 500;
    let songs = (await Array.fromAsync(database.list({ prefix: ['tracks'] })))
        .map((Albums) => (Albums.value as Song))
        .filter((song) => song.subsonic.genres?.some((Genre) => Genre.name === genre));
    const song = [];

    songs = songs.slice(offset, offset + count || 0);

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
        songsByGenre: {
            song: song,
        },
    }, 'ok');
}

getSongsByGenre.get('/getSongsByGenre', handlegetSongsByGenre);
getSongsByGenre.post('/getSongsByGenre', handlegetSongsByGenre);
getSongsByGenre.get('/getSongsByGenre.view', handlegetSongsByGenre);
getSongsByGenre.post('/getSongsByGenre.view', handlegetSongsByGenre);

export default getSongsByGenre;
