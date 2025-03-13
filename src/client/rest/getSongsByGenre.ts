import { Context, Hono } from 'hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { Song, userData } from '../../zod.ts';

const getSongsByGenre = new Hono();

async function handlegetSongsByGenre(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    let count = parseInt(c.req.query('count') || '0');
    const offset = parseInt(c.req.query('offset') || '0');
    const genre = c.req.query('genre');

    if (count > 500) count = 500;
    let songs = (await Array.fromAsync(database.list({ prefix: ['tracks'] })))
        .map((Albums) => (Albums.value as Song))
        .filter((song) => song.subsonic.genres?.some((Genre) => Genre.name === genre));
    const song = [];

    songs = songs.slice(offset, offset + count || 0);

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
