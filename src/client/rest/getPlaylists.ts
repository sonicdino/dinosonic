import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth } from '../../util.ts';
import { Playlist, User } from '../../zod.ts';

const getPlaylists = new Hono();

async function handleGetPlaylists(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    // Get the optional username parameter
    const username = await getField(c, 'username');

    // Check if user is requesting playlists for another user (admin only)
    if (username && username.toLowerCase() !== isValidated.username.toLowerCase() && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'Only admins can retrieve playlists for other users',
        });
    }

    const targetUsername = username || isValidated.username;
    const allowedPlaylists = [];

    const user = await getUserByUsername(targetUsername);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "User doesn't exist" });

    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;

        // Include the playlist if:
        // 1. It belongs to the target user, or
        // 2. It's public (for non-admin users viewing all playlists)
        if (playlist.owner === user.backend.id || (playlist.public && !username)) {
            let ownerUser = (await database.get(['users', playlist.owner])).value as User | null;
            if (!ownerUser) ownerUser = user;

            allowedPlaylists.push({
                id: playlist.id,
                name: playlist.name,
                owner: ownerUser.subsonic.username,
                public: playlist.public,
                created: playlist.created.toISOString(),
                changed: playlist.changed.toISOString(),
                songCount: playlist.songCount,
                duration: playlist.duration,
                comment: playlist.comment,
                coverArt: playlist.coverArt,
            });
        }
    }

    allowedPlaylists.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    return createResponse(c, {
        playlists: {
            playlist: allowedPlaylists,
        },
    }, 'ok');
}

getPlaylists.get('/getPlaylists', handleGetPlaylists);
getPlaylists.post('/getPlaylists', handleGetPlaylists);
getPlaylists.get('/getPlaylists.view', handleGetPlaylists);
getPlaylists.post('/getPlaylists.view', handleGetPlaylists);

export default getPlaylists;
