import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
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

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const track = (await database.get(['tracks', id])).value as Song | null;
    if (track) {
        let userData = (await database.get(['userData', user.backend.id, 'track', track.subsonic.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: track.subsonic.id,
                userRating: rating ? rating : undefined,
            });
        } else userData.userRating = rating ? rating : undefined;
        await database.set(['userData', user.backend.id, 'track', track.subsonic.id], userData);
        return createResponse(c, {}, 'ok');
    }

    const album = (await database.get(['albums', id])).value as Album | null;
    if (album) {
        let userData = (await database.get(['userData', user.backend.id, 'album', album.subsonic.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: album.subsonic.id,
                userRating: rating ? rating : undefined,
            });
        } else userData.userRating = rating ? rating : undefined;
        await database.set(['userData', user.backend.id, 'album', album.subsonic.id], userData);
        return createResponse(c, {}, 'ok');
    }
    const artist = (await database.get(['artists', id])).value as Artist | null;
    if (artist) {
        let userData = (await database.get(['userData', user.backend.id, 'artist', artist.artist.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: artist.artist.id,
                userRating: rating ? rating : undefined,
            });
        } else userData.userRating = rating ? rating : undefined;

        await database.set(['userData', user.backend.id, 'artist', artist.artist.id], userData);
        return createResponse(c, {}, 'ok');
    }

    return createResponse(c, {}, 'failed', { code: 70, message: 'Invalid id provided' });
}

setRating.get('/setRating', handlesetRating);
setRating.post('/setRating', handlesetRating);
setRating.get('/setRating.view', handlesetRating);
setRating.post('/setRating.view', handlesetRating);

export default setRating;
