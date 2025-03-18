import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Playlist } from '../../zod.ts';

const deletePlaylist = new Hono();

async function handleDeletePlaylist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    if (!isValidated.playlistRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'You do not have permission to delete playlists',
        });
    }

    const playlistId = await getField(c, 'id');
    if (!playlistId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing required parameter: 'id'" });

    // Check if the playlist exists
    const playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
    if (!playlist) {
        return createResponse(c, {}, 'failed', {
            code: 70,
            message: 'Playlist not found',
        });
    }

    // Check if the user has permission to delete the playlist
    // Only the playlist owner or an admin can delete the playlist
    if (playlist.owner !== isValidated.username && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'Only the owner of a playlist or an admin can delete it',
        });
    }

    await database.delete(['playlists', playlistId]);

    return createResponse(c, {}, 'ok');
}

deletePlaylist.get('/deletePlaylist', handleDeletePlaylist);
deletePlaylist.post('/deletePlaylist', handleDeletePlaylist);
deletePlaylist.get('/deletePlaylist.view', handleDeletePlaylist);
deletePlaylist.post('/deletePlaylist.view', handleDeletePlaylist);

export default deletePlaylist;
