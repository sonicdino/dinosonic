import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getFields, getUserByUsername, validateAuth } from '../../util.ts';
import { Playlist, Song } from '../../zod.ts';
import { updatePlaylistCover } from '../../PlaylistManager.ts';

const updatePlaylist = new Hono();

async function handleUpdatePlaylist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    if (!isValidated.playlistRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'You do not have permission to modify playlists',
        });
    }

    const playlistId = await getField(c, 'playlistId');
    const name = await getField(c, 'name');
    const comment = await getField(c, 'comment');
    const isPublic = await getField(c, 'public');
    const songIdsToAdd = await getFields(c, 'songIdToAdd') || [];
    const songIndicesToRemove = await getFields(c, 'songIndexToRemove') || [];

    if (!playlistId) {
        return createResponse(c, {}, 'failed', {
            code: 10,
            message: "Missing required parameter: 'playlistId'",
        });
    }

    const playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
    if (!playlist) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Playlist not found' });
    }

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    if (playlist.owner !== user.backend.id && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'Only the owner of a playlist is allowed to update it',
        });
    }

    if (name) playlist.name = name;
    if (comment !== undefined) playlist.comment = comment;
    if (isPublic !== undefined) playlist.public = isPublic === 'true';

    for (const songId of songIdsToAdd) {
        const song = (await database.get(['tracks', songId])).value as Song | null;
        if (!song) continue;

        playlist.entry.push(songId);

        playlist.duration += song.subsonic.duration || 0;
    }

    const indicesToRemove = songIndicesToRemove
        .map((index) => parseInt(index, 10))
        .filter((index) => !isNaN(index) && index >= 0 && index < playlist.entry.length)
        .sort((a, b) => b - a);

    for (const index of indicesToRemove) {
        const songId = playlist.entry[index];
        const song = (await database.get(['tracks', songId as string])).value as Song | null;

        playlist.entry.splice(index, 1);

        if (song) {
            playlist.duration -= song.subsonic.duration || 0;
            if (playlist.duration < 0) playlist.duration = 0;
        }
    }

    playlist.songCount = playlist.entry.length;

    playlist.changed = new Date();

    await database.set(['playlists', playlist.id], playlist);
    await updatePlaylistCover(playlist.id);

    return createResponse(c, {}, 'ok');
}

updatePlaylist.get('/updatePlaylist', handleUpdatePlaylist);
updatePlaylist.post('/updatePlaylist', handleUpdatePlaylist);
updatePlaylist.get('/updatePlaylist.view', handleUpdatePlaylist);
updatePlaylist.post('/updatePlaylist.view', handleUpdatePlaylist);

export default updatePlaylist;
