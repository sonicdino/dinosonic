import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Album, Artist, Song, userData, userDataSchema } from '../../zod.ts';

const setRating = new Hono();

async function handlesetRating(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const id = await getField(c, 'id');
    let rating = parseInt(await getField(c, 'rating') || '0');

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    if (rating && rating > 5) rating = 5;
    if (rating < 0) rating = 0;

    if (id.startsWith('t')) {
        const track = (await database.get(['tracks', id])).value as Song | null;
        if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

        let userData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: track.subsonic.id,
                userRating: rating ? rating : undefined,
            });
        } else userData.userRating = rating ? rating : undefined;
        await database.set(['userData', isValidated.username, 'track', track.subsonic.id], userData);
    } else if (id.startsWith('a')) {
        const album = (await database.get(['albums', id])).value as Album | null;
        if (!album) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

        let userData = (await database.get(['userData', isValidated.username, 'album', album.subsonic.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: album.subsonic.id,
                userRating: rating ? rating : undefined,
            });
        } else userData.userRating = rating ? rating : undefined;
        await database.set(['userData', isValidated.username, 'album', album.subsonic.id], userData);
    } else if (id.startsWith('A')) {
        const artist = (await database.get(['artists', id])).value as Artist | null;
        if (!artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

        let userData = (await database.get(['userData', isValidated.username, 'artist', artist.artist.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: artist.artist.id,
                userRating: rating ? rating : undefined,
            });
        } else userData.userRating = rating ? rating : undefined;
        await database.set(['userData', isValidated.username, 'artist', artist.artist.id], userData);
    } else return createResponse(c, {}, 'failed', { code: 70, message: 'Invalid id provided' });

    return createResponse(c, {}, 'ok');
}

setRating.get('/setRating', handlesetRating);
setRating.post('/setRating', handlesetRating);
setRating.get('/setRating.view', handlesetRating);
setRating.post('/setRating.view', handlesetRating);

export default setRating;
