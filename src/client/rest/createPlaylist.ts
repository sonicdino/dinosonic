import { Context, Hono } from '@hono/hono';
import { createResponse, database, generateId, getField, getFields, getUserByUsername, validateAuth } from '../../util.ts';
import { Playlist, PlaylistSchema, Song, userData } from '../../zod.ts';
import { updatePlaylistCover } from '../../PlaylistManager.ts';

const createPlaylist = new Hono();

async function handleCreatePlaylist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    if (!isValidated.playlistRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'You do not have permission to create or modify playlists',
        });
    }

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const playlistId = await getField(c, 'playlistId');
    const name = await getField(c, 'name');
    const songIds = await getFields(c, 'songId') || [];

    if (!playlistId && !name) {
        return createResponse(c, {}, 'failed', {
            code: 10,
            message: "Missing required parameter: either 'playlistId' (for updating) or 'name' (for creating)",
        });
    }

    let playlist: Playlist | null = null;
    let isUpdate = false;

    // Check if we're updating an existing playlist
    if (playlistId) {
        isUpdate = true;
        playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
        if (!playlist) return createResponse(c, {}, 'failed', { code: 70, message: 'Playlist not found' });

        // Check ownership
        if (playlist.owner !== user.backend.id && !isValidated.adminRole) {
            return createResponse(c, {}, 'failed', {
                code: 50,
                message: 'You do not have permission to modify this playlist',
            });
        }
    }

    // Calculate total duration and collect valid songs
    let totalDuration = 0;
    const validSongIds = [];
    const entries = [];

    // Validate songs and calculate duration
    for (const songId of songIds) {
        const song = (await database.get(['tracks', songId])).value as Song | null;
        if (!song) continue; // Skip invalid song IDs

        const userData = (await database.get(['userData', user.backend.id, 'track', songId])).value as userData | undefined;
        if (userData) {
            if (userData.starred) song.subsonic.starred = userData.starred.toISOString();
            if (userData.played) song.subsonic.played = userData.played.toISOString();
            if (userData.playCount) song.subsonic.playCount = userData.playCount;
            if (userData.userRating) song.subsonic.userRating = userData.userRating;
        }

        totalDuration += song.subsonic.duration || 0;
        validSongIds.push(songId);
        entries.push(song.subsonic);
    }

    // Create new playlist or update existing one
    if (!isUpdate) {
        // Generate a new ID for the playlist
        const newPlaylistId = await generateId();

        playlist = PlaylistSchema.parse({
            id: newPlaylistId,
            name: name as string,
            owner: user.backend.id,
            public: false, // Default to private
            created: new Date(),
            changed: new Date(),
            songCount: validSongIds.length,
            duration: totalDuration,
            entry: validSongIds,
        });
    } else if (playlist) {
        // Update existing playlist
        playlist.name = name || playlist.name;
        playlist.changed = new Date();
        playlist.entry = validSongIds;
        playlist.songCount = validSongIds.length;
        playlist.duration = totalDuration;
    }

    // Save playlist to database
    if (playlist) {
        await database.set(['playlists', playlist.id], playlist);
        await updatePlaylistCover(playlist.id);

        const finalPlaylistState = (await database.get(['playlists', playlist.id])).value as Playlist | null;
        if (!finalPlaylistState) return createResponse(c, {}, 'failed', { code: 0, message: 'Failed to retrieve playlist after update' });

        return createResponse(c, {
            playlist: {
                id: playlist.id,
                name: playlist.name,
                owner: isValidated.username,
                public: playlist.public,
                created: playlist.created.toISOString(),
                changed: playlist.changed.toISOString(),
                songCount: playlist.songCount,
                duration: playlist.duration,
                entry: entries,
                comment: playlist.comment,
                coverArt: playlist.coverArt,
            },
        }, 'ok');
    }

    return createResponse(c, {}, 'failed', { code: 0, message: 'Failed to create/update playlist' });
}

createPlaylist.get('/createPlaylist', handleCreatePlaylist);
createPlaylist.post('/createPlaylist', handleCreatePlaylist);
createPlaylist.get('/createPlaylist.view', handleCreatePlaylist);
createPlaylist.post('/createPlaylist.view', handleCreatePlaylist);

export default createPlaylist;
