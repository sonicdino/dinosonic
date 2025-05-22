import { Context, Hono } from '@hono/hono';
import { checkInternetConnection, config, createResponse, database, getField, getUserByUsername, logger, validateAuth } from '../../util.ts'; // Added logger
import { ArtistSchema, SongID3, SongSchema, userData } from '../../zod.ts'; // Added Schemas
import { getArtistIDByName } from '../../MediaScanner.ts';
import { getTopTracks } from '../../LastFM.ts';

const getTopSongs = new Hono();

async function handlegetTopSongs(c: Context) {
    const userAuth = await validateAuth(c);
    if (userAuth instanceof Response) return userAuth;

    const artistNameParam = await getField(c, 'artist') || '';
    const count = parseInt(await getField(c, 'count') || '50');

    if (!artistNameParam) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'artist'" });

    const artistId = await getArtistIDByName(artistNameParam);
    if (!artistId) return createResponse(c, {}, 'failed', { code: 70, message: `Artist '${artistNameParam}' not found` });

    const artistEntry = await database.get(['artists', artistId]);
    if (!artistEntry.value) return createResponse(c, {}, 'failed', { code: 70, message: 'Artist data not found after resolving ID.' });

    const parsedArtist = ArtistSchema.safeParse(artistEntry.value);
    if (!parsedArtist.success) {
        logger.error(`Malformed artist data for ID ${artistId}`);
        return createResponse(c, {}, 'failed', { code: 70, message: 'Artist data corrupted.' });
    }
    const artist = parsedArtist.data;

    const user = await getUserByUsername(userAuth.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Authenticated user doesn't exist?" });

    let topSongsResult: SongID3[] = [];
    const useLastFm = await checkInternetConnection() && config.last_fm?.enabled && config.last_fm.api_key;

    if (useLastFm) {
        logger.debug(`Fetching top songs for artist '${artist.artist.name}' from Last.fm.`);
        const lastFmTopSongs = await getTopTracks(artist.artist.name, count * 2, artist.artist.musicBrainzId);
        const localSongsForArtist: (SongID3 & { rank: number })[] = [];

        if (lastFmTopSongs && lastFmTopSongs.length > 0) {
            for await (const entry of database.list({ prefix: ['tracks'] })) {
                const songParseResult = SongSchema.safeParse(entry.value);
                if (songParseResult.success) {
                    const localSong = songParseResult.data;
                    if (localSong.subsonic.artists.some(a => a.id === artist.artist.id)) {
                        const lfmMatch = lastFmTopSongs.find((lfmSong: { name: string; rank: number }) =>
                            localSong.subsonic.title.toLowerCase().trim() === lfmSong.name.toLowerCase().trim()
                        );
                        if (lfmMatch) {
                            const songWithUserData = await enrichSongWithUserData(localSong.subsonic, user.backend.id);
                            localSongsForArtist.push({ ...songWithUserData, rank: lfmMatch.rank });
                        }
                    }
                }
            }
            topSongsResult = localSongsForArtist
                .sort((a, b) => a.rank - b.rank)
                .slice(0, count)
                .map(s => { delete (s as { rank?: number }).rank; return s; });
        } else {
            logger.debug(`No top songs returned from Last.fm for '${artist.artist.name}'. Falling back to local method.`);
            // Fall through to local method by not setting topSongsResult or ensuring it's empty
        }
    }

    if (!useLastFm || topSongsResult.length === 0) {
        if (!useLastFm) logger.debug(`Last.fm not available. Fetching top songs for '${artist.artist.name}' locally for user ${user.subsonic.username}.`);
        else logger.debug(`Last.fm returned no results. Fetching top songs for '${artist.artist.name}' locally for user ${user.subsonic.username}.`);

        const songsByArtistWithPlaycount: { song: SongID3; playCount: number }[] = [];
        let hasAnyUserDataForArtist = false;

        for await (const entry of database.list({ prefix: ['tracks'] })) {
            const songParseResult = SongSchema.safeParse(entry.value);
            if (songParseResult.success) {
                const localSongFull = songParseResult.data;
                if (localSongFull.subsonic.artists.some(a => a.id === artist.artist.id)) {
                    const userTrackData = (await database.get(['userData', user.backend.id, 'track', localSongFull.subsonic.id])).value as userData | undefined;
                    const playCount = userTrackData?.playCount || 0;
                    if (playCount > 0) {
                        hasAnyUserDataForArtist = true; // Mark that we found some play history
                    }
                    const songWithUserData = await enrichSongWithUserData(localSongFull.subsonic, user.backend.id);
                    songsByArtistWithPlaycount.push({ song: songWithUserData, playCount: playCount });
                }
            }
        }

        if (hasAnyUserDataForArtist) {
            // Sort by playCount if there's listening history
            logger.debug(`Sorting by play count for artist '${artist.artist.name}'.`);
            topSongsResult = songsByArtistWithPlaycount
                .sort((a, b) => b.playCount - a.playCount)
                .slice(0, count)
                .map(item => item.song);
        } else {
            // No userData with playcounts for this artist by this user, fallback to simple first 'count' songs
            logger.debug(`No play count data for artist '${artist.artist.name}' by user ${user.subsonic.username}. Falling back to first ${count} tracks.`);
            // songsByArtistWithPlaycount already contains all songs by the artist.
            // We can sort them by album, then track number for a somewhat sensible default.
            topSongsResult = songsByArtistWithPlaycount
                .sort((a, b) => {
                    const albumCompare = (a.song.albumId || '').localeCompare(b.song.albumId || '');
                    if (albumCompare !== 0) return albumCompare;
                    return (a.song.track || 0) - (b.song.track || 0);
                })
                .slice(0, count)
                .map(item => item.song);
        }
    }

    return createResponse(c, {
        topSongs: { song: topSongsResult },
    }, 'ok');
}

async function enrichSongWithUserData(song: SongID3, userId: string): Promise<SongID3> {
    const userTrackData = ((await database.get(['userData', userId, 'track', song.id])).value as userData) || {};
    return {
        ...song,
        starred: userTrackData.starred ? userTrackData.starred.toISOString() : undefined,
        playCount: userTrackData.playCount, // This will be used for local sorting
        userRating: userTrackData.userRating,
        played: userTrackData.played ? userTrackData.played.toISOString() : undefined,
    };
}

getTopSongs.get('/getTopSongs', handlegetTopSongs);
getTopSongs.post('/getTopSongs', handlegetTopSongs);
getTopSongs.get('/getTopSongs.view', handlegetTopSongs);
getTopSongs.post('/getTopSongs.view', handlegetTopSongs);

export default getTopSongs;