import { Context, Hono } from 'hono';
import { createResponse, database, encryptForTokenAuth, getField, updateUsernameReferences, validateAuth } from '../../util.ts';
import { User, UserSchema } from '../../zod.ts';

const updateUser = new Hono();

async function handleUpdateUser(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: 'Only admins can access this endpoint.' });

    const toBoolean = (value: unknown) => (value !== undefined ? value === 'true' : undefined);

    const newUsername = await getField(c, 'username');
    let password = await getField(c, 'password');
    const email = await getField(c, 'email');
    const adminRole = toBoolean(await getField(c, 'adminRole'));
    const settingsRole = toBoolean(await getField(c, 'settingsRole'));
    const streamRole = toBoolean(await getField(c, 'streamRole'));
    const downloadRole = toBoolean(await getField(c, 'downloadRole'));
    const playlistRole = toBoolean(await getField(c, 'playlistRole'));
    const coverArtRole = toBoolean(await getField(c, 'coverArtRole'));
    const shareRole = toBoolean(await getField(c, 'shareRole'));
    const scrobblingEnabled = toBoolean(await getField(c, 'scrobblingEnabled'));

    if (!newUsername) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });
    if (password && password.startsWith('enc:')) password = atob(password.slice(4));
    if (password) password = await encryptForTokenAuth(password);

    const existingUser = (await database.get(['users', newUsername.toLowerCase()])).value as User | undefined;
    if (!existingUser) return createResponse(c, {}, 'failed', { code: 40, message: "User doesn't exist. Try creating the user instead." });

    const oldUsername = existingUser.backend.username;
    const usernameChanged = oldUsername !== newUsername.toLowerCase();

    const updatedUser = await UserSchema.safeParseAsync({
        backend: {
            username: newUsername.toLowerCase(),
            password: password ?? existingUser.backend.password, // Keep existing password if not provided
        },
        subsonic: {
            username: newUsername,
            email: email ?? existingUser.subsonic.email,
            adminRole: adminRole ?? existingUser.subsonic.adminRole,
            settingsRole: settingsRole ?? existingUser.subsonic.settingsRole,
            downloadRole: downloadRole ?? existingUser.subsonic.downloadRole,
            playlistRole: playlistRole ?? existingUser.subsonic.playlistRole,
            coverArtRole: coverArtRole ?? existingUser.subsonic.coverArtRole,
            streamRole: streamRole ?? existingUser.subsonic.streamRole,
            shareRole: shareRole ?? existingUser.subsonic.shareRole,
            scrobblingEnabled: scrobblingEnabled ?? existingUser.subsonic.scrobblingEnabled,
        },
    });

    if (!updatedUser.success) return createResponse(c, {}, 'failed', { code: 10, message: 'A field is set wrong' });

    // If the username changed, update all references
    try {
        if (usernameChanged) await updateUsernameReferences(oldUsername, newUsername);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
        return createResponse(c, {}, 'failed', { code: 20, message: errorMessage });
    }
    // Save updated user
    await database.set(['users', newUsername], updatedUser.data);

    return createResponse(c, {}, 'ok');
}

updateUser.get('/updateUser', handleUpdateUser);
updateUser.post('/updateUser', handleUpdateUser);
updateUser.get('/updateUser.view', handleUpdateUser);
updateUser.post('/updateUser.view', handleUpdateUser);

export default updateUser;
