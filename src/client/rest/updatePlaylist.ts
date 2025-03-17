import { Context, Hono } from 'hono';
import { createResponse, database, getField, getFields, validateAuth } from '../../util.ts';
import { Playlist, Song } from '../../zod.ts';

const updatePlaylist = new Hono();

async function handleUpdatePlaylist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    
    if (!isValidated.playlistRole) {
        return createResponse(c, {}, 'failed', { 
            code: 50, 
            message: 'You do not have permission to modify playlists'
        });
    }
    
    // Get parameters
    const playlistId = await getField(c, 'playlistId');
    const name = await getField(c, 'name');
    const comment = await getField(c, 'comment');
    const isPublic = await getField(c, 'public');
    const songIdsToAdd = await getFields(c, 'songIdToAdd') || [];
    const songIndicesToRemove = await getFields(c, 'songIndexToRemove') || [];
    
    // Validate playlistId parameter
    if (!playlistId) {
        return createResponse(c, {}, 'failed', { 
            code: 10, 
            message: "Missing required parameter: 'playlistId'" 
        });
    }
    
    // Retrieve the playlist
    const playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
    if (!playlist) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Playlist not found' });
    }
    
    // Check ownership
    if (playlist.owner !== isValidated.username && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', { 
            code: 50, 
            message: 'Only the owner of a playlist is allowed to update it' 
        });
    }
    
    // Update playlist properties if provided
    if (name) {
        playlist.name = name;
    }
    
    if (comment !== undefined) {
        playlist.comment = comment;
    }
    
    if (isPublic !== undefined) {
        playlist.public = isPublic === 'true';
    }
    
    // Process song additions
    for (const songId of songIdsToAdd) {
        const song = (await database.get(['tracks', songId])).value as Song | null;
        if (!song) continue; // Skip invalid song IDs
        
        // Add the song ID to the playlist entry array
        playlist.entry.push(songId);
        
        // Update duration
        playlist.duration += song.subsonic.duration || 0;
    }
    
    // Process song removals (from highest index to lowest to avoid index shifting issues)
    const indicesToRemove = songIndicesToRemove
        .map(index => parseInt(index, 10))
        .filter(index => !isNaN(index) && index >= 0 && index < playlist.entry.length)
        .sort((a, b) => b - a); // Sort in descending order
    
    for (const index of indicesToRemove) {
        const songId = playlist.entry[index];
        const song = (await database.get(['tracks', songId])).value as Song | null;
        
        // Remove the song
        playlist.entry.splice(index, 1);
        
        // Update duration if the song exists
        if (song) {
            playlist.duration -= song.subsonic.duration || 0;
            if (playlist.duration < 0) playlist.duration = 0; // Safeguard
        }
    }
    
    // Update songCount
    playlist.songCount = playlist.entry.length;
    
    // Update changed timestamp
    playlist.changed = new Date();
    
    // Save the updated playlist
    await database.set(['playlists', playlist.id], playlist);
    
    return createResponse(c, {}, 'ok');
}

updatePlaylist.get('/updatePlaylist', handleUpdatePlaylist);
updatePlaylist.post('/updatePlaylist', handleUpdatePlaylist);
updatePlaylist.get('/updatePlaylist.view', handleUpdatePlaylist);
updatePlaylist.post('/updatePlaylist.view', handleUpdatePlaylist);

export default updatePlaylist;