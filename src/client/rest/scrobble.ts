import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { nowPlaying, Song, userData, userDataSchema } from '../../zod.ts';

const scrobble = new Hono();

async function handleScrobble(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.scrobblingEnabled) return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to scrobble' });
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
        let userTrackData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
        if (!userTrackData) {
            userTrackData = userDataSchema.parse({
                id: track.subsonic.id,
                played: time,
                playCount: 1,
            });
        } else {
            userTrackData.played = time;
            userTrackData.playCount = (userTrackData.playCount || 0) + 1;
        }

        let userAlbumData = (await database.get(['userData', isValidated.username, 'album', track.subsonic.albumId])).value as userData | undefined;
        if (!userAlbumData) {
            userAlbumData = userDataSchema.parse({
                id: track.subsonic.id,
                played: time,
                playCount: 1,
            });
        } else {
            userAlbumData.played = time;
            userAlbumData.playCount = (userTrackData.playCount || 0) + 1;
        }

        await database.set(['userData', isValidated.username, 'track', track.subsonic.id], userTrackData);
        await database.set(['userData', isValidated.username, 'album', track.subsonic.id], userAlbumData);
    }
    // TODO: LastFM Scrobble. This is only possible after UI is done.

    return createResponse(c, {}, 'ok');
}

scrobble.get('/scrobble', handleScrobble);
scrobble.post('/scrobble', handleScrobble);
scrobble.get('/scrobble.view', handleScrobble);
scrobble.post('/scrobble.view', handleScrobble);

export default scrobble;
