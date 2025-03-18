import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Playlist, Song, userData } from '../../zod.ts';

const getPlaylist = new Hono();

async function handleGetPlaylist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    // Get the playlist ID parameter
    const playlistId = await getField(c, 'id');
    if (!playlistId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing required parameter: 'id'" });

    // Retrieve the playlist
    const playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
    if (!playlist) return createResponse(c, {}, 'failed', { code: 70, message: 'Playlist not found' });

    // Check if user has access to the playlist
    if (!playlist.public && playlist.owner !== isValidated.username && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'You do not have permission to view this playlist',
        });
    }

    // Build the song entries
    const entries = [];
    for (const songId of playlist.entry) {
        const song = (await database.get(['tracks', songId as string])).value as Song | undefined;
        if (!song) continue;

        const userData = (await database.get(['userData', isValidated.username, 'track', songId as string])).value as userData | undefined;
        if (userData) {
            if (userData.starred) song.subsonic.starred = userData.starred.toISOString();
            if (userData.played) song.subsonic.played = userData.played.toISOString();
            if (userData.playCount) song.subsonic.playCount = userData.playCount;
            if (userData.userRating) song.subsonic.userRating = userData.userRating;
        }

        entries.push(song.subsonic);
    }
    return createResponse(c, {
        playlist: {
            id: playlist.id,
            name: playlist.name,
            owner: playlist.owner,
            public: playlist.public,
            created: playlist.created.toISOString(),
            changed: playlist.changed.toISOString(),
            songCount: playlist.songCount,
            duration: playlist.duration,
            comment: playlist.comment,
            coverArt: playlist.coverArt,
            entry: entries,
        },
    }, 'ok');
}

getPlaylist.get('/getPlaylist', handleGetPlaylist);
getPlaylist.post('/getPlaylist', handleGetPlaylist);
getPlaylist.get('/getPlaylist.view', handleGetPlaylist);
getPlaylist.post('/getPlaylist.view', handleGetPlaylist);

export default getPlaylist;
