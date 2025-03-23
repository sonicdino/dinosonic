import { Context, Hono } from 'hono';
import { config, createResponse, database, getField, signParams, validateAuth } from '../../util.ts';
import { nowPlaying, Song, User, userData, userDataSchema } from '../../zod.ts';

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

    const nowPlayingKey = ['nowPlaying', isValidated.username, 'client', client, 'track', track.subsonic.id];
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
                id: track.subsonic.albumId,
                played: time,
                playCount: 1,
            });
        } else {
            userAlbumData.played = time;
            userAlbumData.playCount = (userTrackData.playCount || 0) + 1;
        }

        await database.set(['userData', isValidated.username, 'track', track.subsonic.id], userTrackData);
        await database.set(['userData', isValidated.username, 'album', track.subsonic.albumId], userAlbumData);
    }

    // **LastFM Scrobbling**
    if (config.last_fm?.enable_scrobbling && config.last_fm.api_key && config.last_fm.api_secret) {
        const user = (await database.get(['users', isValidated.username.toLowerCase()])).value as User | null;
        if (user?.backend.lastFMSessionKey) {
            const sig = new URLSearchParams({
                method: submission ? 'track.scrobble' : 'track.updateNowPlaying',
                api_key: config.last_fm.api_key,
                sk: user.backend.lastFMSessionKey,
                artist: track.subsonic.artist,
                track: track.subsonic.title,
                album: track.subsonic.album,
                timestamp: Math.floor(time.getTime() / 1000).toString(),
                format: 'json',
            });

            // Append API signature
            sig.append('api_sig', signParams(sig, config.last_fm.api_secret));

            try {
                const response = await fetch('https://ws.audioscrobbler.com/2.0/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: sig,
                });

                const data = await response.json();
                if (!response.ok || data.error) {
                    console.error(`Last.fm Scrobble Error:`, data);
                    return createResponse(c, {}, 'failed', { code: 60, message: 'Last.fm Scrobble Error' });
                }
            } catch (err) {
                console.error(`Last.fm API Request Failed:`, err);
                return createResponse(c, {}, 'failed', { code: 61, message: 'Failed to connect to Last.fm' });
            }
        }
    }

    return createResponse(c, {}, 'ok');
}

scrobble.get('/scrobble', handleScrobble);
scrobble.post('/scrobble', handleScrobble);
scrobble.get('/scrobble.view', handleScrobble);
scrobble.post('/scrobble.view', handleScrobble);

export default scrobble;
