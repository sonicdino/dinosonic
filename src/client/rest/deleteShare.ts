import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { ShareSchema } from '../../zod.ts'; // Added PlaylistSchema

const deleteShare = new Hono();
const TEMP_PLAYLIST_PREFIX = 'dinosonic_temp_share_playlist_'; // Same as in createShare

async function handleDeleteShare(c: Context) {
    const userAuth = await validateAuth(c);
    if (userAuth instanceof Response) return userAuth;

    const shareId = await getField(c, 'id');
    if (!shareId) {
        return createResponse(c, {}, 'failed', { code: 10, message: "Missing required parameter: 'id'." });
    }

    const shareEntry = await database.get(['shares', shareId]);
    if (!shareEntry.value) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Share not found.' });
    }
    const share = ShareSchema.parse(shareEntry.value);

    if (share.userId !== userAuth.id && !userAuth.adminRole) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'User not authorized to delete this share.' });
    }

    // Attempt to delete the temporary playlist if this share pointed to one
    if (share.itemType === 'playlist' && share.itemId.startsWith(TEMP_PLAYLIST_PREFIX)) {
        const tempPlaylistEntry = await database.get(['playlists', share.itemId]);
        if (tempPlaylistEntry.value) {
            // Optional: Add more checks, e.g., ensure no other share points to this temp playlist
            await database.delete(['playlists', share.itemId]);
            logger.info(`Deleted temporary share playlist: ${share.itemId}`);
        } else {
            logger.warn(`Temporary share playlist ${share.itemId} for share ${shareId} not found for deletion.`);
        }
    }

    await database.delete(['shares', shareId]);
    logger.info(`Deleted share: ${shareId}`);
    return createResponse(c, {}); // Subsonic expects an empty success response
}

deleteShare.get('/deleteShare', handleDeleteShare);
deleteShare.post('/deleteShare', handleDeleteShare);
deleteShare.get('/deleteShare.view', handleDeleteShare);
deleteShare.post('/deleteShare.view', handleDeleteShare);

export default deleteShare;
