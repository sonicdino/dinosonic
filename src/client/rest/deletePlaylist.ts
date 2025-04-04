import { Context, Hono } from 'hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Playlist, User } from '../../zod.ts';

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

    const owner = (await database.get(['users', playlist.owner])).value as User | null;
    if (!owner) return createResponse(c, {}, 'failed', { code: 0, message: 'The owner of this playlist is invalid! Contact the admin to fix this.' });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    // Check if the user has permission to delete the playlist
    // Only the playlist owner or an admin can delete the playlist
    if (owner.backend.id !== user.backend.id && !isValidated.adminRole) {
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
