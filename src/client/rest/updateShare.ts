import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, logger, /*parseTimeToMs,*/ validateAuth } from '../../util.ts';
import { ShareSchema } from '../../zod.ts';

const updateShare = new Hono();

async function handleUpdateShare(c: Context) {
    const userAuth = await validateAuth(c);
    if (userAuth instanceof Response) return userAuth;

    const shareId = await getField(c, 'id');
    const description = await getField(c, 'description'); // Optional
    // const expiresInStr = await getField(c, 'expiresIn'); // Optional: "7d", "24h", "0" or "" to remove
    const expiresTimestampStr = await getField(c, 'expires'); // Optional: direct timestamp in ms, "0" or "" to remove

    if (!shareId) {
        return createResponse(c, {}, 'failed', { code: 10, message: "Missing required parameter: 'id'." });
    }

    const shareEntry = await database.get(['shares', shareId]);
    if (!shareEntry.value) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Share not found.' });
    }

    const share = ShareSchema.parse(shareEntry.value);

    if (share.userId !== userAuth.id && !userAuth.adminRole) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'User not authorized to update this share.' });
    }

    let updated = false;
    if (description !== undefined) {
        share.description = description === '' ? undefined : description; // Allow clearing description
        updated = true;
    }

    if (expiresTimestampStr !== undefined) { // Prioritize direct timestamp
        if (expiresTimestampStr === '' || expiresTimestampStr === '0') {
            share.expires = null;
        } else if (/^\d+$/.test(expiresTimestampStr)) {
            const ts = parseInt(expiresTimestampStr, 10);
            if (ts > Date.now()) { // Only set if it's a future timestamp
                share.expires = new Date(ts);
            } else if (ts !== 0) { // If ts is not 0 and not in future, it's invalid/past
                logger.warn(`UpdateShare: expires timestamp ${ts} is in the past or invalid. Expiry not changed.`);
                // No change to share.expires here, keep existing or null
            } else { // ts is 0 (but not empty string which is handled above) means clear
                share.expires = null;
            }
        } else {
            logger.warn(`UpdateShare: Invalid expires timestamp format: ${expiresTimestampStr}. Expiry not changed.`);
        }
        updated = true;
    } /* else if (expiresInStr !== undefined) { // Fallback to expiresIn duration string
        if (expiresInStr === '' || expiresInStr === '0') {
            share.expires = null;
        } else {
            const ms = parseTimeToMs(expiresInStr);
            if (ms > 0) {
                share.expires = new Date(Date.now() + ms);
            } else {
                logger.warn(`UpdateShare: Invalid expiresIn value: '${expiresInStr}'. Expiry not changed.`);
                // No change to share.expires here
            }
        }
        updated = true;
    }*/

    if (updated) {
        const validatedShare = ShareSchema.parse(share); // Re-validate before saving
        await database.set(['shares', shareId], validatedShare);
    }

    return createResponse(c, {}, 'ok'); // Subsonic expects an empty success response
}

updateShare.get('/updateShare', handleUpdateShare);
updateShare.post('/updateShare', handleUpdateShare);
updateShare.get('/updateShare.view', handleUpdateShare);
updateShare.post('/updateShare.view', handleUpdateShare);

export default updateShare;
