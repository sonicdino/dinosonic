import { Context, Hono } from 'hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { Album, Song } from '../../zod.ts';

const getGenres = new Hono();

async function handlegetGenres(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const songGenres = (await Array.fromAsync(database.list({ prefix: ['tracks'] })))
        .flatMap((track) => (track.value as Song).subsonic.genres || []);
    const albumGenres = (await Array.fromAsync(database.list({ prefix: ['albums'] })))
        .flatMap((album) => (album.value as Album).subsonic.genres || []);

    const genreMap = new Map<string, { value: string; songCount: number; albumCount: number }>();

    for (const genre of songGenres) {
        if (!genreMap.has(genre.name)) {
            genreMap.set(genre.name, { value: genre.name, songCount: 0, albumCount: 0 });
        }
        genreMap.get(genre.name)!.songCount++;
    }

    // Count occurrences for albums
    for (const genre of albumGenres) {
        if (!genreMap.has(genre.name)) {
            genreMap.set(genre.name, { value: genre.name, songCount: 0, albumCount: 0 });
        }
        genreMap.get(genre.name)!.albumCount++;
    }

    return createResponse(c, {
        genres: { genre: Array.from(genreMap.values()) },
    }, 'ok');
}

getGenres.get('/getGenres', handlegetGenres);
getGenres.post('/getGenres', handlegetGenres);
getGenres.get('/getGenres.view', handlegetGenres);
getGenres.post('/getGenres.view', handlegetGenres);

export default getGenres;
