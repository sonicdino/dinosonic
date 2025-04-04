import { Context, Hono } from 'hono';
import { checkInternetConnection, config, createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Artist, Song, SongID3, userData } from '../../zod.ts';
import { getArtistIDByName } from '../../MediaScanner.ts';
import { getTopTracks } from '../../LastFM.ts';

const getTopSongs = new Hono();

async function handlegetTopSongs(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artistName = await getField(c, 'artist') || '';
    const count = parseInt(await getField(c, 'count') || '50');

    if (!artistName) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'artist'" });
    const artist = (await database.get(['artists', await getArtistIDByName(artistName) || ''])).value as Artist | null;
    if (!artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Artist not found' });
    const matchedSongs: { track: SongID3; rank: number }[] = [];

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    if (await checkInternetConnection() && config.last_fm?.enabled && config.last_fm.api_key) {
        const lastFmTopSongs = await getTopTracks(artist.artist.name, config.last_fm?.api_key, count, artist.artist.musicBrainzId);

        for await (const entry of database.list({ prefix: ['tracks'] })) {
            const track = entry.value as Song;
            const filter = lastFmTopSongs.find((lastFmSong: Record<string, string>) =>
                track.subsonic.artist?.toLowerCase().trim() === artist.artist.name.toLowerCase().trim() &&
                track.subsonic.title.toLowerCase().trim() === lastFmSong.name.toLowerCase().trim() &&
                !matchedSongs.some((matched) => matched.track.title.toLowerCase().trim() === lastFmSong.name.toLowerCase().trim())
            );

            if (filter) {
                const userData = (await database.get(['userData', user.backend.id, 'track', track.subsonic.id])).value as userData | undefined;
                if (userData) {
                    if (userData.starred) track.subsonic.starred = userData.starred.toISOString();
                    if (userData.played) track.subsonic.played = userData.played.toISOString();
                    if (userData.playCount) track.subsonic.playCount = userData.playCount;
                    if (userData.userRating) track.subsonic.userRating = userData.userRating;
                }
                matchedSongs.push({ track: track.subsonic, rank: filter.rank });
            }
        }
    } else {
        // TODO: If no LastFM api key provided, or LastFM is disabled, sort top songs by most listened.
    }

    return createResponse(c, {
        topSongs: { song: matchedSongs.sort((a, b) => a.rank - b.rank).map((matched) => matched.track) },
    }, 'ok');
}

getTopSongs.get('/getTopSongs', handlegetTopSongs);
getTopSongs.post('/getTopSongs', handlegetTopSongs);
getTopSongs.get('/getTopSongs.view', handlegetTopSongs);
getTopSongs.post('/getTopSongs.view', handlegetTopSongs);

export default getTopSongs;
