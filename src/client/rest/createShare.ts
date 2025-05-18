import { Context, Hono } from '@hono/hono';
import {
    createResponse,
    database,
    generateId,
    getField,
    getFields, // Use getFields
    getUserByUsername,
    logger,
    validateAuth,
} from '../../util.ts';
import { AlbumSchema, PlaylistSchema, ShareSchema, Song, SongSchema } from '../../zod.ts';

const createShare = new Hono();

const TEMP_PLAYLIST_PREFIX = 'dinosonic_temp_share_playlist_';

async function handleCreateShare(c: Context) {
    const userAuth = await validateAuth(c);
    if (userAuth instanceof Response) return userAuth;
    if (!userAuth.shareRole && !userAuth.adminRole) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'User not authorized to create shares.' });
    }

    const user = await getUserByUsername(userAuth.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: 'Authenticated user not found.' });

    // Use getFields to handle multiple 'id' parameters
    const itemIds = await getFields(c, 'id');
    const description = await getField(c, 'description');
    const expiresTimestampStr = await getField(c, 'expires'); // Direct timestamp in ms

    if (!itemIds || itemIds.length === 0) {
        return createResponse(c, {}, 'failed', { code: 10, message: "Missing required parameter: 'id'." });
    }

    let effectiveItemId = itemIds[0];
    let effectiveItemType: 'song' | 'album' | 'playlist';
    const sharedEntries: Song[] = []; // To store actual song objects for the response

    if (itemIds.length === 1) {
        // Single item shared
        const singleId = itemIds[0];
        const trackEntry = await database.get(['tracks', singleId]);
        if (trackEntry.value) {
            effectiveItemType = 'song';
            const song = SongSchema.parse(trackEntry.value);
            sharedEntries.push(song);
        } else {
            const albumEntry = await database.get(['albums', singleId]);
            if (albumEntry.value) {
                effectiveItemType = 'album';
                // For albums, sharedEntries will be populated later
            } else {
                const playlistEntry = await database.get(['playlists', singleId]);
                if (playlistEntry.value) {
                    effectiveItemType = 'playlist';
                    // For playlists, sharedEntries will be populated later
                } else {
                    return createResponse(c, {}, 'failed', { code: 70, message: `Item with ID ${singleId} not found.` });
                }
            }
        }
        effectiveItemId = singleId;
    } else {
        // Multiple song IDs provided, create a temporary playlist
        effectiveItemType = 'playlist';
        const tempPlaylistId = TEMP_PLAYLIST_PREFIX + await generateId();
        const songObjectsForPlaylist: string[] = [];
        let totalDuration = 0;

        for (const songId of itemIds) {
            const songEntry = await database.get(['tracks', songId]);
            if (songEntry.value) {
                const song = SongSchema.parse(songEntry.value);
                songObjectsForPlaylist.push(song.subsonic.id);
                sharedEntries.push(song); // Add to sharedEntries for the response
                totalDuration += song.subsonic.duration;
            } else {
                logger.warn(`Song ID ${songId} not found while creating multi-item share, skipping.`);
            }
        }

        if (songObjectsForPlaylist.length === 0) {
            return createResponse(c, {}, 'failed', { code: 70, message: 'None of the provided song IDs were valid for sharing.' });
        }

        const tempPlaylist = PlaylistSchema.parse({
            id: tempPlaylistId,
            name: description || `Shared Tracks (${new Date().toLocaleDateString()})`,
            owner: user.backend.id,
            public: false, // Temporary playlists are not "public" in the browseable sense
            created: new Date(),
            changed: new Date(),
            songCount: songObjectsForPlaylist.length,
            duration: totalDuration,
            entry: songObjectsForPlaylist, // Store song IDs
            comment: description || `A collection of ${songObjectsForPlaylist.length} shared tracks.`,
        });
        await database.set(['playlists', tempPlaylistId], tempPlaylist);
        effectiveItemId = tempPlaylistId;
        logger.info(`Created temporary playlist ${tempPlaylistId} for sharing songs: ${itemIds.join(', ')}`);
    }

    // Populate sharedEntries if album or non-temporary playlist
    if (effectiveItemType === 'album') {
        const albumEntry = await database.get(['albums', effectiveItemId]);
        if (albumEntry.value) {
            const album = AlbumSchema.parse(albumEntry.value);
            for (const songId of album.subsonic.song) {
                const songEntry = await database.get(['tracks', songId as string]);
                if (songEntry.value) sharedEntries.push(SongSchema.parse(songEntry.value));
            }
        }
    } else if (effectiveItemType === 'playlist' && !effectiveItemId.startsWith(TEMP_PLAYLIST_PREFIX)) {
        const playlistEntry = await database.get(['playlists', effectiveItemId]);
        if (playlistEntry.value) {
            const playlist = PlaylistSchema.parse(playlistEntry.value);
            for (const songId of playlist.entry) {
                const songEntry = await database.get(['tracks', songId as string]);
                if (songEntry.value) sharedEntries.push(SongSchema.parse(songEntry.value));
            }
        }
    }

    const shareId = await generateId();
    const now = new Date();
    let expiresDate: Date | null = null;

    if (expiresTimestampStr && /^\d+$/.test(expiresTimestampStr)) {
        const ts = parseInt(expiresTimestampStr, 10);
        if (ts === 0) {
            expiresDate = null;
        } else if (ts > Date.now()) {
            expiresDate = new Date(ts);
        } else {
            logger.warn(`Provided expires timestamp ${ts} is in the past. Ignoring.`);
        }
    }

    const newShare = ShareSchema.parse({
        id: shareId,
        userId: user.backend.id,
        itemId: effectiveItemId,
        itemType: effectiveItemType,
        description: description,
        created: now,
        expires: expiresDate,
        viewCount: 0,
    });

    await database.set(['shares', shareId], newShare);

    const shareUrl = `${new URL(c.req.url).origin}/share/${shareId}`;

    // Subsonic expects <entry> for each actual song, even if one share link
    const responseEntries = sharedEntries.map((s) => ({
        ...(s.subsonic), // Spread subsonic song details
        // Potentially add user-specific data like 'starred' if needed for the context of the share response
    }));

    return createResponse(c, {
        shares: { // Subsonic API expects a 'shares' wrapper
            share: [{ // Even for a single created share, it's often in an array
                id: shareId,
                url: shareUrl,
                description: newShare.description,
                username: userAuth.username,
                created: newShare.created.toISOString(),
                expires: newShare.expires?.toISOString(),
                lastVisited: newShare.lastViewed?.toISOString(),
                visitCount: newShare.viewCount,
                entry: responseEntries.length > 0 ? responseEntries : [{ id: effectiveItemId, title: description || effectiveItemType }],
            }],
        },
    });
}

createShare.get('/createShare', handleCreateShare);
createShare.post('/createShare', handleCreateShare);
createShare.get('/createShare.view', handleCreateShare);
createShare.post('/createShare.view', handleCreateShare);

export default createShare;
