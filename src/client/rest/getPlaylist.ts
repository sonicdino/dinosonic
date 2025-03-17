import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Playlist, Song, userData } from '../../zod.ts';

const getPlaylist = new Hono();

async function handleGetPlaylist(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    
    // Get the playlist ID parameter
    const playlistId = await getField(c, 'id');
    
    // Validate required parameter
    if (!playlistId) {
        return createResponse(c, {}, 'failed', { 
            code: 10, 
            message: "Missing required parameter: 'id'" 
        });
    }
    
    // Retrieve the playlist
    const playlist = (await database.get(['playlists', playlistId])).value as Playlist | null;
    if (!playlist) {
        return createResponse(c, {}, 'failed', { 
            code: 70, 
            message: 'Playlist not found' 
        });
    }
    
    // Check if user has access to the playlist
    if (!playlist.public && playlist.owner !== isValidated.username && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', { 
            code: 50, 
            message: 'You do not have permission to view this playlist' 
        });
    }
    
    // Build the song entries
    const entries = [];
    for (const songId of playlist.entry) {
        const song = (await database.get(['tracks', songId])).value as Song | undefined;
        if (!song) continue; // Skip invalid song IDs
        
        // Get user-specific metadata for this song
        const userData = (await database.get(['userData', isValidated.username, 'track', songId])).value as userData | undefined;
        
        // Clone the song to avoid modifying the original
        const songEntry = { ...song.subsonic };
        
        // Apply user-specific metadata if available
        if (userData) {
            if (userData.starred) songEntry.starred = userData.starred.toISOString();
            if (userData.played) songEntry.played = userData.played.toISOString();
            if (userData.playCount) songEntry.playCount = userData.playCount;
            if (userData.userRating) songEntry.userRating = userData.userRating;
        }
        
        entries.push(songEntry);
    }
    
    // Format the response according to Subsonic API
    const response = {
        id: playlist.id,
        name: playlist.name,
        owner: playlist.owner,
        public: playlist.public,
        created: playlist.created.toISOString(),
        changed: playlist.changed.toISOString(),
        songCount: playlist.songCount,
        duration: playlist.duration,
        entry: entries
    };
    
    // Add optional fields if they exist
    if (playlist.comment) response.comment = playlist.comment;
    if (playlist.coverArt) response.coverArt = playlist.coverArt;
    
    return createResponse(c, { playlist: response }, 'ok');
}

getPlaylist.get('/getPlaylist', handleGetPlaylist);
getPlaylist.post('/getPlaylist', handleGetPlaylist);
getPlaylist.get('/getPlaylist.view', handleGetPlaylist);
getPlaylist.post('/getPlaylist.view', handleGetPlaylist);

export default getPlaylist;