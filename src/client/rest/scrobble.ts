import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { nowPlaying, Song, userData, userDataSchema } from '../../zod.ts';

const scrobble = new Hono();

async function handleScrobble(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const id = await getField(c, 'id');
    const time = new Date(parseInt(await getField(c, 'time') || Date.now().toString(), 10));
    const client = await getField(c, 'c');
    let submission: string | boolean | undefined = await getField(c, 'submission');
    if (!submission) submission = true;
    submission = submission === 'true';

    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    if (!client) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'c'" });

    const track = (await database.get(['tracks', id])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

    const nowPlayingEntry = (await database.get(['nowPlaying', isValidated.username, 'client', client, 'track', track.subsonic.id])).value as
        | nowPlaying
        | undefined;
    if (!nowPlayingEntry || nowPlayingEntry.playerName !== client) {
        await database.set(['nowPlaying', isValidated.username, 'client', client, 'track', track.subsonic.id], {
            track: track.subsonic,
            minutesAgo: time,
            username: isValidated.username,
            playerName: client,
        });
    }

    if (submission) {
        await database.delete(['nowPlaying', isValidated.username, 'client', client, 'track', track.subsonic.id]);
        let userData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
        if (!userData) {
            userData = userDataSchema.parse({
                id: track.subsonic.id,
                played: time,
                playCount: 1,
            });
        } else {
            userData.played = time;
            userData.playCount = (userData.playCount || 0) + 1;
        }
        await database.set(['userData', isValidated.username, 'track', track.subsonic.id], userData);
    }
    // TODO: LastFM Scrobble.

    return createResponse(c, {}, 'ok');
}

scrobble.get('/scrobble', handleScrobble);
scrobble.post('/scrobble', handleScrobble);
scrobble.get('/scrobble.view', handleScrobble);
scrobble.post('/scrobble.view', handleScrobble);

export default scrobble;
