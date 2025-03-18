import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Playlist } from '../../zod.ts';

const getPlaylists = new Hono();

async function handleGetPlaylists(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    // Get the optional username parameter
    const username = await getField(c, 'username');

    // Check if user is requesting playlists for another user (admin only)
    if (username && username !== isValidated.username && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', {
            code: 50,
            message: 'Only admins can retrieve playlists for other users',
        });
    }

    // Determine which user's playlists to fetch
    const targetUsername = username || isValidated.username;

    // Collect all playlists the user is allowed to see
    const allowedPlaylists = [];

    // Iterate through all playlists
    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;

        // Include the playlist if:
        // 1. It belongs to the target user, or
        // 2. It's public (for non-admin users viewing all playlists)
        if (playlist.owner === targetUsername || (playlist.public && !username)) {
            // Create a response object without the entry array to keep it lightweight
            allowedPlaylists.push({
                id: playlist.id,
                name: playlist.name,
                owner: playlist.owner,
                public: playlist.public,
                created: (playlist.created as Date).toISOString(),
                changed: (playlist.changed as Date).toISOString(),
                songCount: playlist.songCount,
                duration: playlist.duration,
                comment: playlist.comment,
                coverArt: playlist.coverArt,
            });
        }
    }

    // Sort playlists by creation date (newest first)
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
