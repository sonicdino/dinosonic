import { Context, Hono } from 'hono';
import { createResponse, database, encryptForTokenAuth, getField, getNextId, getUserByUsername, hexToString, validateAuth } from '../../util.ts';
import { UserSchema } from '../../zod.ts';

const createUser = new Hono();

async function handlecreateUser(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: 'Only admins can access this endpoint.' });

    const username = await getField(c, 'username');
    let password = await getField(c, 'password');
    const email = await getField(c, 'email');
    // const ldapAuthenticated = (await getField(c, 'ldapAuthenticated')) === 'true';
    const adminRole = (await getField(c, 'adminRole')) === 'true';
    const settingsRole = (await getField(c, 'settingsRole')) === 'true' ? (await getField(c, 'settingsRole')) === 'true' : true;
    const streamRole = await getField(c, 'streamRole') ? (await getField(c, 'streamRole')) === 'true' : true;
    const jukeboxRole = /* (await getField(c, 'jukeboxRole')) === 'true' // Jukebox is not planned. */ false;
    const downloadRole = (await getField(c, 'downloadRole')) === 'true';
    const uploadRole = /* (await getField(c, 'uploadRole')) === 'true' // Videos are not planned. */ false;
    const playlistRole = await getField(c, 'playlistRole') ? (await getField(c, 'playlistRole')) === 'true' : true;
    const coverArtRole = await getField(c, 'coverArtRole') ? (await getField(c, 'coverArtRole')) === 'true' : true;
    const commentRole = /* (await getField(c, 'commentRole')) === 'true' // Comments are not planned. */ false;
    const podcastRole = /* (await getField(c, 'podcastRole')) === 'true' // Podcasts are not planned. */ false;
    const shareRole = /* (await getField(c, 'shareRole')) === 'true' // Sharing is not planned in the moment. */ false;
    const scrobblingEnabled = await getField(c, 'streamRole') ? (await getField(c, 'streamRole')) === 'true' : true;
    // const videoConversionRole = (await getField(c, 'videoConversionRole')) === 'true'; // Videos are not planned.

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });
    if (!password) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'password'" });

    const user = await getUserByUsername(username);
    if (user) return createResponse(c, {}, 'failed', { code: 40, message: 'That username is already in use' });

    if (password.startsWith('enc:')) password = hexToString(password.slice(4));
    password = await encryptForTokenAuth(password);

    const User = UserSchema.parse({
        backend: { id: await getNextId('u'), username: username.toLowerCase(), password },
        subsonic: {
            username,
            email,
            adminRole,
            settingsRole,
            downloadRole,
            uploadRole,
            playlistRole,
            coverArtRole,
            commentRole,
            podcastRole,
            streamRole,
            jukeboxRole,
            shareRole,
            scrobblingEnabled,
        },
    });

    await database.set(['users', User.backend.id], User);

    return createResponse(c, {}, 'ok');
}

createUser.get('/createUser', handlecreateUser);
createUser.post('/createUser', handlecreateUser);
createUser.get('/createUser.view', handlecreateUser);
createUser.post('/createUser.view', handlecreateUser);

export default createUser;
