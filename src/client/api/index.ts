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
    logger,
    SERVER_VERSION,
} from '../../util.ts';
import { generateJWT } from '../middleware.ts';
import { deleteCookie, setCookie } from '@std/http/cookie';
import {
    Album,
    AlbumSchema,
    CoverArtSchema,
    Playlist,
    PlaylistSchema,
    ShareSchema,
    Song,
    SongSchema,
    SubsonicUser,
    User,
    UserSchema,
} from '../../zod.ts';
import { hardReset } from '../../MediaScanner.ts';
import path from 'node:path';
import { ensureDir } from '@std/fs/ensure-dir';
import { exists } from '@std/fs/exists';
import { validateToken } from '../../ListenBrainz.ts';
const api = new Hono();

api.get('/public-stream/:shareId/:itemId', async (c: Context) => {
    const { shareId, itemId } = c.req.param();

    const shareEntry = await database.get(['shares', shareId]);
    if (!shareEntry.value) {
        logger.warn(`Public stream attempt: Share ID ${shareId} not found.`);
        return c.text('Invalid or expired share link for streaming.', 404);
    }
    const shareParseResult = ShareSchema.safeParse(shareEntry.value);
    if (!shareParseResult.success) {
        logger.error(`Public stream attempt: Malformed share data for ${shareId}.`);
        return c.text('Share data corrupted.', 500);
    }
    const share = shareParseResult.data;

    if (share.expires && new Date(share.expires) < new Date()) {
        logger.info(`Public stream attempt: Share ID ${shareId} has expired.`);
        await database.delete(['shares', shareId]);
        return c.text('Share link has expired.', 410);
    }

    let isValidItemForShare = false;
    switch (share.itemType) {
        case 'song':
            if (share.itemId === itemId) {
                isValidItemForShare = true;
            }
            break;
        case 'album': {
            const albumEntry = await database.get(['albums', share.itemId]);
            if (albumEntry.value) {
                const album = AlbumSchema.parse(albumEntry.value);
                // deno-lint-ignore no-explicit-any
                if (album.subsonic.song.some((songIdOrObj: any) => (typeof songIdOrObj === 'string' ? songIdOrObj : songIdOrObj.id) === itemId)) {
                    isValidItemForShare = true;
                }
            }
            break;
        }
        case 'playlist': {
            const playlistEntry = await database.get(['playlists', share.itemId]);
            if (playlistEntry.value) {
                const playlist = PlaylistSchema.parse(playlistEntry.value);
                // deno-lint-ignore no-explicit-any
                if (playlist.entry.some((songIdOrObj: any) => (typeof songIdOrObj === 'string' ? songIdOrObj : songIdOrObj.id) === itemId)) {
                    isValidItemForShare = true;
                }
            }
            break;
        }
        default:
            logger.warn(`Public stream attempt: Share ${shareId} is for ${share.itemType}, not streamable audio.`);
            return c.text('This shared item is not streamable audio.', 400);
    }

    if (!isValidItemForShare) {
        logger.warn(`Public stream attempt: Item ID ${itemId} is not part of share ${shareId} (type: ${share.itemType}).`);
        return c.text('Requested item not part of this share.', 403);
    }

    const trackEntry = await database.get(['tracks', itemId]);
    if (!trackEntry.value) {
        logger.error(`Public stream: Validated item ID ${itemId} (for share ${shareId}) not found in tracks DB.`);
        return c.text('Track data not found.', 404);
    }
    const parsedTrack = SongSchema.safeParse(trackEntry.value);
    if (!parsedTrack.success) {
        logger.error(`Public stream: Malformed track data for validated ID ${itemId}.`);
        return c.text('Track data corrupted.', 500);
    }
    const track = parsedTrack.data;

    const originalFilePath = track.subsonic.path;
    if (!(await exists(originalFilePath))) {
        logger.error(`Original track file not found for validated ID ${itemId} at ${originalFilePath}.`);
        return c.text('Original track file missing.', 404);
    }

    const transcodingEnabled = config.transcoding?.enabled === true;
    const ffmpegPath = config.transcoding?.ffmpeg_path;

    if (transcodingEnabled && ffmpegPath) {
        logger.debug(`Secure public stream for share ${shareId}, item ${itemId}: Transcoding to Opus.`);
        const lowQualityMp3Bitrate = '128k';
        const format = 'mp3';
        const contentType = 'audio/mpeg';
        const ffmpegArgs = [
            '-i',
            originalFilePath,
            '-map_metadata',
            '-1',
            '-map',
            '0:a',
            '-c:a',
            'libmp3lame',
            '-b:a',
            lowQualityMp3Bitrate,
            '-f',
            format,
            '-vn',
            '-nostdin',
            'pipe:1',
        ];
        try {
            const durationInSeconds = track.subsonic.duration;
            const command = new Deno.Command(ffmpegPath, { args: ffmpegArgs, stdout: 'piped', stderr: 'piped' });
            const process = command.spawn();

            if (durationInSeconds) {
                const lowQualityMp3Bitrate = 128000; // in bits per second
                const estimatedContentLength = Math.floor((durationInSeconds * lowQualityMp3Bitrate) / 8);

                c.header('Content-Length', estimatedContentLength.toString());
            }

            c.header('Content-Type', contentType);
            c.header('Accept-Ranges', 'none');
            c.header('Cache-Control', 'public, max-age=3600');
            return c.body(process.stdout);
            // deno-lint-ignore no-explicit-any
        } catch (error: any) {
            logger.error(`Error starting FFmpeg for secure public Opus stream (share ${shareId}, item ${itemId}): ${error.message}. Falling back.`);
        }
    }

    // Fallback: Serve original file
    logger.debug(`Secure public stream for share ${shareId}, item ${itemId}: Serving original.`);
    try {
        const file = await Deno.open(originalFilePath, { read: true });
        const { size } = await file.stat();
        // ... (Range request and file streaming logic as before) ...
        const rangeHeader = c.req.header('Range');
        let start = 0;
        let end = size - 1;

        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                start = parseInt(match[1], 10);
                end = match[2] ? parseInt(match[2], 10) : end;
            }
        }
        const contentLength = end - start + 1;

        c.header('Accept-Ranges', 'bytes');
        c.header('Content-Type', track.subsonic.contentType || 'audio/mpeg');
        c.header('Content-Length', `${contentLength}`);
        c.header('Cache-Control', 'public, max-age=86400');

        if (rangeHeader) {
            c.status(206);
            c.header('Content-Range', `bytes ${start}-${end}/${size}`);
        } else c.status(200);

        await file.seek(start, Deno.SeekMode.Start);
        const readable = new ReadableStream({
            async pull(controller) {
                const buffer = new Uint8Array(64 * 1024);
                const bytesRead = await file.read(buffer);
                if (bytesRead === null || bytesRead === 0) {
                    controller.close();
                    file.close();
                } else {
                    controller.enqueue(buffer.subarray(0, bytesRead));
                }
            },
            cancel() {
                file.close();
            },
        });
        return c.body(readable);

        // deno-lint-ignore no-explicit-any
    } catch (error: any) {
        logger.error(`Error streaming original (fallback) for secure public stream (share ${shareId}, item ${itemId}): ${error.message}`);
        return c.text('Error streaming file', 500);
    }
});

// Public Cover Art Endpoint
const mimeToExtPublic: Record<string, string> = { // To avoid conflict if util.ts has a similar map
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
};

api.get('/public-cover/:itemId', async (c: Context) => {
    const { itemId } = c.req.param();
    const sizeParam = c.req.query('size');
    const size = sizeParam ? parseInt(sizeParam, 10) : 0;

    const coverEntry = await database.get(['covers', itemId]);
    if (!coverEntry.value) {
        return c.text('Cover not found', 404);
    }
    const parsedCover = CoverArtSchema.safeParse(coverEntry.value);
    if (!parsedCover.success) {
        logger.error(`Malformed public cover art data in DB for ID ${itemId}`);
        return c.text('Cover data corrupted', 500);
    }
    const cover = parsedCover.data;

    if (!(await exists(cover.path))) { // Use aliased fsExists
        logger.error(`Original public cover file not found at path: ${cover.path} for ID ${itemId}`);
        return c.text('Original cover file missing', 404);
    }

    c.header('Cache-Control', 'public, max-age=86400');

    if (!size || !config.transcoding?.enabled || !config.transcoding.ffmpeg_path) {
        try {
            const fileData = await Deno.readFile(cover.path);
            c.header('Content-Type', cover.mimeType);
            return c.body(fileData);
        } catch (e) {
            logger.error(`Error reading original public cover ${itemId}: ${e}`);
            return c.text('Error serving original cover', 500);
        }
    }

    const cachePublicCoversDir = path.join(globalThis.__tmpDir, 'cache', 'public_covers');
    await ensureDir(cachePublicCoversDir);

    const ext = mimeToExtPublic[cover.mimeType.toLowerCase()] || 'jpg';
    const cachedCoverPath = path.join(cachePublicCoversDir, `${itemId}_${size}.${ext}`);

    if (await exists(cachedCoverPath)) {
        try {
            const fileData = await Deno.readFile(cachedCoverPath);
            c.header('Content-Type', cover.mimeType);
            return c.body(fileData);
        } catch (e) {
            logger.warn(`Error reading cached public cover ${cachedCoverPath}, will attempt to regenerate: ${e}`);
        }
    }

    const ffmpegPath = config.transcoding?.ffmpeg_path;
    if (!ffmpegPath) {
        logger.error(`FFmpeg path not configured for public cover ID ${itemId}. Falling back.`);
        const fileData = await Deno.readFile(cover.path);
        c.header('Content-Type', cover.mimeType);
        return c.body(fileData);
    }

    logger.debug(`Resizing public cover for ID ${itemId} to size ${size}, output: ${cachedCoverPath}`);
    const process = new Deno.Command(ffmpegPath, {
        args: ['-i', cover.path, '-vf', `scale=${size}:${size}`, '-y', cachedCoverPath],
        stdout: 'piped',
        stderr: 'piped',
    });
    try {
        const { success, stderr } = await process.output();
        if (!success) {
            const errorMsg = new TextDecoder().decode(stderr);
            logger.error(`Public Cover FFmpeg failed for ${itemId} (size ${size}): ${errorMsg}. Falling back.`);
            const fileData = await Deno.readFile(cover.path);
            c.header('Content-Type', cover.mimeType);
            return c.body(fileData);
        }

        if (!(await exists(cachedCoverPath))) {
            logger.error(`FFmpeg success for public cover ${itemId} (size ${size}) but ${cachedCoverPath} not found. Falling back.`);
            const fileData = await Deno.readFile(cover.path);
            c.header('Content-Type', cover.mimeType);
            return c.body(fileData);
        }

        const resizedFileData = await Deno.readFile(cachedCoverPath);
        c.header('Content-Type', cover.mimeType);
        return c.body(resizedFileData);
        // deno-lint-ignore no-explicit-any
    } catch (error: any) {
        logger.error(`Error processing public cover ${itemId} (size ${size}): ${error.message}. Falling back.`);
        const fileData = await Deno.readFile(cover.path);
        c.header('Content-Type', cover.mimeType);
        return c.body(fileData);
    }
});

// --- Existing API Endpoints ---
api.get('/version', (c: Context) => {
    return c.json({ version: SERVER_VERSION });
});

api.get('/public-share-details/:shareId', async (c: Context) => {
    const { shareId } = c.req.param();
    const shareEntry = await database.get(['shares', shareId]);

    if (!shareEntry.value) {
        return c.json({ error: 'Share not found' }, 404);
    }
    const share = ShareSchema.parse(shareEntry.value);

    if (share.expires && new Date(share.expires) < new Date()) {
        await database.delete(['shares', shareId]);
        return c.json({ error: 'Share has expired' }, 410);
    }
    share.viewCount = (share.viewCount || 0) + 1;
    share.lastViewed = new Date();
    await database.set(['shares', shareId], share);

    let itemData: unknown = null;
    let ownerUsername = 'Unknown';
    const ownerEntry = await database.get(['users', share.userId]);
    if (ownerEntry.value) {
        ownerUsername = (UserSchema.parse(ownerEntry.value) as User).subsonic.username;
    }

    switch (share.itemType) {
        case 'song': {
            const songVal = (await database.get(['tracks', share.itemId])).value;
            if (songVal) itemData = (SongSchema.parse(songVal) as Song).subsonic;
            break;
        }

        case 'album': {
            const albumVal = (await database.get(['albums', share.itemId])).value;
            if (albumVal) {
                const albumData = AlbumSchema.parse(albumVal) as Album;
                const songs = [];
                for (const songId of albumData.subsonic.song) {
                    const sVal = (await database.get(['tracks', songId as string])).value;
                    if (sVal) songs.push((SongSchema.parse(sVal) as Song).subsonic);
                }
                albumData.subsonic.song = songs.sort((a, b) => (a.track || 0) - (b.track || 0));
                itemData = albumData.subsonic;
            }
            break;
        }
        case 'playlist': {
            const plVal = (await database.get(['playlists', share.itemId])).value;
            if (plVal) {
                const plData = PlaylistSchema.parse(plVal) as Playlist;
                const songs = [];
                for (const songId of plData.entry) {
                    const sVal = (await database.get(['tracks', songId as string])).value;
                    if (sVal) songs.push((SongSchema.parse(sVal) as Song).subsonic);
                }
                plData.entry = songs;
                itemData = plData;
            }
            break;
        }
        case 'coverArt': { // CoverArt itself is the item data
            const coverVal = (await database.get(['covers', share.itemId])).value;
            if (coverVal) itemData = CoverArtSchema.parse(coverVal);
            break;
        }
        default:
            logger.error(`Invalid share item type: ${share.itemType} for share ${shareId}`);
            return c.json({ error: 'Invalid share item type' }, 500);
    }
    if (!itemData) {
        logger.warn(`Shared item ${share.itemId} (type ${share.itemType}) for share ${shareId} not found in DB.`);
        return c.json({ error: 'Shared item data not found' }, 404);
    }
    return c.json({ share, item: itemData, ownerUsername });
});

api.get('/status', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) return c.json({ error: 'User not found. Try relogging.' }, 401);

    return c.json({
        lastFMScrobblingEnabled: config.last_fm?.enable_scrobbling,
        listenBrainzScrobblingEnabled: config.listenbrainz?.enable_scrobbling,
        lastfm: !!user.backend.lastFMSessionKey,
        listenBrainz: !!user.backend.listenBrainzToken,
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

api.post('/logout', (c: Context) => {
    deleteCookie(c.res.headers, 'Dinosonic_Auth', { path: '/' });
    return c.json({ message: 'Logged out' });
});

// Transcoding Profiles maybe

// last.fm linking
api.get('/link/lastfm', (c: Context) => {
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

api.post('/link/listenbrainz', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    if (!sessionUser?.user.username) {
        return c.json({ success: false, error: 'Authentication required.' }, 401);
    }

    let body;
    try {
        body = await c.req.json();
    } catch (_) {
        return c.json({ success: false, error: 'Invalid request body. Expected JSON.' }, 400);
    }

    const token = body.token;
    if (!token || typeof token !== 'string') {
        return c.json({ success: false, error: 'User token is missing or invalid in the request body.' }, 400);
    }

    const validationResult = await validateToken(token);
    if (!validationResult.valid) {
        return c.json({ success: false, error: 'The provided ListenBrainz token is not valid.' }, 400);
    }

    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) {
        return c.json({ success: false, error: 'User not found in the database.' }, 500);
    }

    user.backend.listenBrainzToken = token;
    await database.set(['users', user.backend.id], user);

    logger.info(`Successfully linked ListenBrainz account for user: ${user.subsonic.username}`);

    return c.json({
        success: true,
        userName: validationResult.userName,
    });
});

api.get('/unlink/listenbrainz', async (c: Context) => {
    const sessionUser = c.get('user') as { user: SubsonicUser; exp: number };
    if (!sessionUser?.user.username) {
        return c.json({ success: false, error: 'Authentication required.' }, 401);
    }

    const user = await getUserByUsername(sessionUser.user.username);
    if (!user) {
        return c.json({ success: false, error: 'User not found in the database.' }, 500);
    }

    user.backend.listenBrainzToken = undefined;
    await database.set(['users', user.backend.id], user);

    logger.info(`Unlinked ListenBrainz account for user: ${user.subsonic.username}`);

    return c.redirect('/admin/');
});
export default api;
