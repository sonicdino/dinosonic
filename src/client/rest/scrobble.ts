import { Context, Hono } from '@hono/hono';
import { checkInternetConnection, createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { nowPlaying, Song, userData, userDataSchema } from '../../zod.ts';
import { scrobble as LastFMScrobble } from '../../LastFM.ts';
import { scrobble as ListenBrainzScrobble } from '../../ListenBrainz.ts';

const scrobble = new Hono();

async function handleScrobble(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.scrobblingEnabled) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'You have no permission to scrobble' });
    }

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

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const nowPlayingKey = ['nowPlaying', user.backend.id, 'client', client, 'track', track.subsonic.id];
    const nowPlayingEntry = (await database.get(nowPlayingKey)).value as nowPlaying | undefined;

    if (!nowPlayingEntry && !submission) {
        await database.set(nowPlayingKey, {
            track: track.subsonic,
            minutesAgo: time,
            username: isValidated.username,
            playerName: client,
        });
    }

    if (submission) {
        await database.delete(nowPlayingKey);
        let userTrackData = (await database.get(['userData', user.backend.id, 'track', track.subsonic.id])).value as userData | undefined;
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

        let userAlbumData = (await database.get(['userData', user.backend.id, 'album', track.subsonic.albumId])).value as userData | undefined;
        if (!userAlbumData) {
            userAlbumData = userDataSchema.parse({
                id: track.subsonic.albumId,
                played: time,
                playCount: 1,
            });
        } else {
            userAlbumData.played = time;
            userAlbumData.playCount = (userTrackData.playCount || 0) + 1;
        }

        await database.set(['userData', user.backend.id, 'track', track.subsonic.id], userTrackData);
        await database.set(['userData', user.backend.id, 'album', track.subsonic.albumId], userAlbumData);
    }

    const internetAccess = await checkInternetConnection();

    if (internetAccess) {
        await LastFMScrobble(user, submission, time, track);
        await ListenBrainzScrobble(user, submission, time, track);
    }

    return createResponse(c, {}, 'ok');
}

scrobble.get('/scrobble', handleScrobble);
scrobble.post('/scrobble', handleScrobble);
scrobble.get('/scrobble.view', handleScrobble);
scrobble.post('/scrobble.view', handleScrobble);

export default scrobble;
