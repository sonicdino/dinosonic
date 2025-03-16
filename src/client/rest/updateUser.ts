import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { User, UserSchema } from '../../zod.ts';

const updateUser = new Hono();

async function handleupdateUser(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: 'Only admins can access this endpoint.' });

    const toBoolean = (value: unknown) => (value !== undefined ? value === 'true' : undefined);

    const username = await getField(c, 'username');
    let password = await getField(c, 'password');
    const email = await getField(c, 'email');
    // const ldapAuthenticated = await getField(c, 'ldapAuthenticated');
    const adminRole = toBoolean(await getField(c, 'adminRole'));
    const settingsRole = toBoolean(await getField(c, 'settingsRole'));
    const streamRole = toBoolean(await getField(c, 'streamRole'));
    const jukeboxRole = /* (await getField(c, 'jukeboxRole')) === 'true' // Jukebox is not planned. */ false;
    const downloadRole = toBoolean(await getField(c, 'downloadRole'));
    const uploadRole = /* (await getField(c, 'uploadRole')) === 'true' // Videos are not planned. */ false;
    const playlistRole = toBoolean(await getField(c, 'playlistRole'));
    const coverArtRole = toBoolean(await getField(c, 'coverArtRole'));
    const commentRole = /* (await getField(c, 'commentRole')) === 'true' // Comments are not planned. */ false;
    const podcastRole = /* (await getField(c, 'podcastRole')) === 'true' // Podcasts are not planned. */ false;
    const shareRole = toBoolean(await getField(c, 'shareRole'));
    const scrobblingEnabled = toBoolean(await getField(c, 'scrobblingEnabled'));
    // const videoConversionRole = await getField(c, 'videoConversionRole'); // Videos are not planned.

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });
    if (password && password.startsWith('enc:')) password = atob(password.slice(4));

    const user = (await database.get(['users', username.toLowerCase()])).value as User | undefined;
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: "User doesn't exist. Try creating the user instead." });

    const updatedUser = await UserSchema.safeParseAsync({
        backend: {
            username: username.toLowerCase(),
            password: password ?? user.backend.password, // Keep existing password if not provided
        },
        subsonic: {
            username,
            email: email ?? user.subsonic.email,
            adminRole: adminRole ?? user.subsonic.adminRole,
            settingsRole: settingsRole ?? user.subsonic.settingsRole,
            downloadRole: downloadRole ?? user.subsonic.downloadRole,
            uploadRole: uploadRole ?? user.subsonic.uploadRole,
            playlistRole: playlistRole ?? user.subsonic.playlistRole,
            coverArtRole: coverArtRole ?? user.subsonic.coverArtRole,
            commentRole: commentRole ?? user.subsonic.commentRole,
            podcastRole: podcastRole ?? user.subsonic.podcastRole,
            streamRole: streamRole ?? user.subsonic.streamRole,
            jukeboxRole: jukeboxRole ?? user.subsonic.jukeboxRole,
            shareRole: shareRole ?? user.subsonic.shareRole,
            scrobblingEnabled: scrobblingEnabled ?? user.subsonic.scrobblingEnabled,
        },
    });

    if (!updatedUser.success) return createResponse(c, {}, 'failed', { code: 10, message: 'A field is set wrong' });

    await database.set(['users', username], updatedUser.data);

    return createResponse(c, {}, 'ok');
}

updateUser.get('/updateUser', handleupdateUser);
updateUser.post('/updateUser', handleupdateUser);
updateUser.get('/updateUser.view', handleupdateUser);
updateUser.post('/updateUser.view', handleupdateUser);

export default updateUser;
