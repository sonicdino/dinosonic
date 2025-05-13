import { Context, Hono } from '@hono/hono';
import {
    config,
    database,
    decryptForTokenAuth,
    deleteUserReferences,
    encryptForTokenAuth,
    generateId,
    getSessionKey,
    getUserByUsername,
    SERVER_VERSION,
} from '../../util.ts';
import { generateJWT } from '../middleware.ts';
import { deleteCookie, setCookie } from '@std/http/cookie';
import { SubsonicUser, User, UserSchema } from '../../zod.ts';
import { hardReset } from '../../MediaScanner.ts';
const api = new Hono();

// Stats maybe
api.get('/version', (c: Context) => {
    return c.json({ version: SERVER_VERSION });
});

api.get('/status', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) return c.json({ error: 'User not found. Try relogging.' }, 401);

    return c.json({
        lastFMScrobblingEnabled: config.last_fm?.enable_scrobbling,
        lastfm: !!user.backend.lastFMSessionKey,
        listenbrainz: !!user.backend.listenbrainzToken,
    });
});

api.get('/hardReset', (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    if (!sessionUser.user.adminRole) return c.json({ error: 'Unauthorized' }, 403);

    hardReset();

    return c.json({ message: 'Hard reset started.' });
});

// User management
api.get('/users', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };

    if (!sessionUser.user.adminRole) {
        return c.json({
            currentUser: sessionUser.user, // Include current user info
            users: [sessionUser.user], // Non-admins only see themselves
        });
    }

    const users = (await Array.fromAsync(database.list({ prefix: ['users'] })))
        .map((entry) => (entry.value as User).subsonic);

    return c.json({
        currentUser: sessionUser.user, // Current user info
        users, // Admins see all users
    });
});

api.post('/users', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    if (!sessionUser.user.adminRole) return c.json({ error: 'Unauthorized' }, 403);

    let { username, password } = await c.req.json();

    if (!username || !password) return c.json({ error: 'Missing fields' }, 400);
    const exists = await getUserByUsername(username);
    if (exists) return c.json({ error: 'User already exists!' }, 400);

    password = await encryptForTokenAuth(password);

    const newUser: User = {
        backend: {
            id: await generateId(),
            username: username.toLowerCase(),
            password,
        },
        subsonic: {
            username,
            adminRole: false,
            settingsRole: true,
            streamRole: true,
            jukeboxRole: false,
            uploadRole: false,
            commentRole: false,
            podcastRole: false,
            shareRole: false,
            downloadRole: false,
            playlistRole: true,
            coverArtRole: true,
            scrobblingEnabled: true,
        },
    };

    await database.set(['users', newUser.backend.id], newUser);
    return c.json({ message: 'User created' });
});

api.put('/users/:username', async (c: Context) => {
    const { username: oldUsername } = c.req.param();
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };

    if (!sessionUser.user.adminRole && sessionUser.user.username !== oldUsername) {
        return c.json({ error: 'Unauthorized' }, 403);
    }

    // Fetch the existing user
    const existingUser = await getUserByUsername(oldUsername);
    if (!existingUser) return c.json({ error: 'User not found' }, 404);

    // Parse request body
    const updatedData = await c.req.json();
    const newUsername = updatedData.username?.toLowerCase() || oldUsername.toLowerCase();

    if (updatedData.password) existingUser.backend.password = await encryptForTokenAuth(updatedData.password);
    if (oldUsername.toLowerCase() !== newUsername) {
        existingUser.subsonic.username = updatedData.username;
        existingUser.backend.username = newUsername;
    }

    // Validate user object
    const updatedUser = UserSchema.safeParse({
        backend: existingUser.backend,
        subsonic: { ...existingUser.subsonic, ...updatedData.permissions },
    });

    if (!updatedUser.success) {
        return c.json({ error: 'Invalid user settings!', errors: updatedUser.error?.format() });
    }

    // If username changed, update all references

    // Save updated user
    await database.set(['users', updatedUser.data.backend.id], updatedUser.data);

    return c.json({ message: 'User updated' });
});

api.delete('/users/:username', async (c: Context) => {
    const { username } = c.req.param();
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };

    if (!sessionUser.user.adminRole) return c.json({ error: 'Unauthorized' }, 403);
    if (sessionUser.user.username === username) return c.json({ error: 'You cannot delete yourself' }, 400);

    // Fetch the user to check if they exist
    const existingUser = await getUserByUsername(username);
    if (!existingUser) return c.json({ error: 'User not found' }, 404);

    // Delete everything related to the user
    await deleteUserReferences(existingUser.backend.id);

    return c.json({ message: 'User and all related data deleted' });
});

api.get('/users/:username', async (c: Context) => {
    const { username } = c.req.param();
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };

    if (!sessionUser.user.adminRole && sessionUser.user.username !== username) return c.json({ error: 'Unauthorized' }, 403);

    const user = await getUserByUsername(username);
    if (!user) return c.json({ error: 'User not found' }, 404);

    return c.json(user.subsonic);
});

api.post('/login', async (c: Context) => {
    const { username, password } = await c.req.json();
    // Replace with actual authentication check
    if (!username) return c.json({ error: 'No username provided' }, 401);
    if (!password) return c.json({ error: 'No password provided' }, 401);

    const user = await getUserByUsername(username);
    if (!user) return c.json({ error: "User doesn't exist" }, 401);

    const originalPassword = await decryptForTokenAuth(user.backend.password);
    if (password !== originalPassword) return c.json({ error: 'Wrong password' }, 401);

    const token = await generateJWT(user.subsonic);

    // Store token in HTTP-only cookie
    setCookie(c.res.headers, {
        name: 'Dinosonic_Auth',
        value: token,
        httpOnly: true,
        secure: c.req.url.startsWith('https'),
        sameSite: 'Lax',
        path: '/', // Ensures the cookie is available site-wide
    });

    return c.json({ ok: true, message: 'Login successful' });
});

api.post('/logout', (c) => {
    deleteCookie(c.res.headers, 'Dinosonic_Auth', { path: '/' });
    return c.json({ message: 'Logged out' });
});

// Transcoding Profiles maybe

// last.fm linking
api.get('/link/lastfm', (c) => {
    const url = new URL(c.req.url); // Extract base URL dynamically
    const callbackUrl = `${url.origin}/api/callback/lastfm`;

    const authUrl = `https://www.last.fm/api/auth/?api_key=${config.last_fm?.api_key}&cb=${encodeURIComponent(callbackUrl)}`;

    return c.redirect(authUrl);
});

api.get('/unlink/lastfm', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) return c.json({ error: 'User not found. Try relogging.' }, 401);

    user.backend.lastFMSessionKey = undefined;
    await database.set(['users', user.backend.id], user);

    return c.redirect('/admin/');
});

api.get('/unlink/listenbrainz', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) return c.json({ error: 'User not found. Try relogging.' }, 401);

    user.backend.listenbrainzToken = undefined;
    await database.set(['users', user.backend.id], user);
});

api.get('/callback/lastfm', async (c: Context) => {
    const token = c.req.query('token');
    if (!token) return c.text('Missing token', 400);

    const sessionKey = await getSessionKey(token);
    if (!sessionKey) return c.text('Failed to get session', 400);

    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) return c.json({ error: 'User not found. Try relogging.' }, 401);

    user.backend.lastFMSessionKey = sessionKey;
    await database.set(['users', user.backend.id], user);

    return c.redirect('/admin/');
});

// listenbrainz linking (maybe)

export default api;
