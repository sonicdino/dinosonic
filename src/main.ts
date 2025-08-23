import {
    Album,
    AlbumSchema,
    Config,
    ConfigSchema,
    CoverArt,
    CoverArtSchema,
    nowPlaying,
    Playlist,
    PlaylistSchema,
    ShareSchema,
    Song,
    SongSchema,
    UserSchema,
} from './zod.ts';
import { scanMediaDirectories } from './MediaScanner.ts';
import { parseArgs } from '@std/cli';
import { ensureAdminUserExistsHybrid, logger, parseTimeToMs, registerTempDirCleanup, SERVER_VERSION, setConstants, setupLogger } from './util.ts';
import restRoutes from './client/rest/index.ts';
import apiRoutes from './client/api/index.ts';
import { Context, Hono, Next } from '@hono/hono';
import { cors } from '@hono/hono/cors';
import { serveStatic } from '@hono/hono/deno';
import { parse } from '@std/toml';
import * as path from '@std/path';
import { authMiddleware } from './client/middleware.ts';
import { ensureDir } from '@std/fs';
let configFile = Deno.env.get('DINO_CONFIG_FILE');
let config = null;

if (Deno.args.length) {
    const args = parseArgs(Deno.args, {
        boolean: ['help', 'version'],
        string: ['config'],
        alias: { help: 'h', version: 'v', config: 'c' },
        unknown: (arg) => {
            console.error(
                `Unknown option "${arg}". try running "denosonic -h" for help.`,
            );
            Deno.exit(127);
        },
    });

    if (args.config) configFile = Deno.args[1];
    if (args.help) {
        console.log(`Usage: dinosonic [OPTIONS...]`);
        console.log('\nOptional flags:');
        console.log('  -h, --help                Display this help and exit');
        console.log(
            '  -v, --version             Display the current version of Dinosonic',
        );
        console.log(
            '  -c, --config              Set the config file location. Default will be "./config.json"',
        );
        Deno.exit(0);
    }

    if (args.version) {
        console.log(SERVER_VERSION);
        Deno.exit(0);
    }
}

logger.info(configFile ? `Config file: ${configFile}` : 'No config file provided, trying to get configuration from env.');

let configParse;
if (configFile) {
    const configText = await Deno.readTextFile(configFile);
    configParse = ConfigSchema.safeParse(parse(configText));
} else {
    const conf: Config = {
        port: parseInt(Deno.env.get('DINO_PORT') || '4100'),
        log_level: Deno.env.get('DINO_LOG_LEVEL') || 'OFF',
        // @ts-expect-error If data folder is not set via env, error and exit.
        data_folder: Deno.env.get('DINO_DATA_FOLDER'),
        ui_folder: Deno.env.get('DINO_UI_FOLDER'),
        music_folders: Deno.env.get('DINO_MUSIC_FOLDERS')?.split(';') || [],
        scan_on_start: Deno.env.get('DINO_SCAN_ON_START') === 'true',
        scan_interval: Deno.env.get('DINO_SCAN_INTERVAL') || '1d',
        artist_separators: (Deno.env.get('DINO_ARTIST_SEPARATORS') || ';/').split(''),
        genre_separators: (Deno.env.get('DINO_GENRE_SEPARATORS') || ';,').split(''),
        // @ts-expect-error If default admin password is not set via env, error and exit.
        default_admin_password: Deno.env.get('DINO_DEFAULT_ADMIN_PASSWORD'),
    };

    if (Deno.env.get('DINO_LASTFM_ENABLED') || Deno.env.get('DINO_LASTFM_SCROBBLING')) {
        conf.last_fm = {
            enabled: Deno.env.get('DINO_LASTFM_ENABLED') === 'true' || Deno.env.get('DINO_LASTFM_SCROBBLING') === 'true',
            api_key: Deno.env.get('DINO_LASTFM_APIKEY'),
            api_secret: Deno.env.get('DINO_LASTFM_APISECRET'),
            enable_scrobbling: Deno.env.get('DINO_LASTFM_SCROBBLING') === 'true',
        };
    }

    if (Deno.env.get('DINO_SPOTIFY_ENABLED') || (Deno.env.get('DINO_SPOTIFY_CLIENT_ID') && Deno.env.get('DINO_SPOTIFY_CLIENT_SECRET'))) {
        conf.spotify = {
            enabled: Deno.env.get('DINO_SPOTIFY_ENABLED') === 'true',
            client_id: Deno.env.get('DINO_SPOTIFY_CLIENT_ID'),
            client_secret: Deno.env.get('DINO_SPOTIFY_CLIENT_SECRET'),
        };
    }

    if (Deno.env.get('DINO_LISTENBRAINZ_SCROBBLING')) {
        conf.listenbrainz = {
            enable_scrobbling: Deno.env.get('DINO_LISTENBRAINZ_SCROBBLING') === 'true'
        }
    }

    if (Deno.env.get('DINO_TRANSCODING_ENABLED')) {
        conf.transcoding = {
            enabled: typeof Deno.env.get('DINO_TRANSCODING_ENABLED') === 'string' ? Deno.env.get('DINO_TRANSCODING_ENABLED') === 'true' : true,
            ffmpeg_path: Deno.env.get('DINO_FFMPEG_PATH') || 'ffmpeg',
        };
    }

    configParse = ConfigSchema.safeParse(conf);
}

if (!configParse.success) {
    console.error(configParse.error.format());
    Deno.exit(1);
}

config = configParse.data;

if (!config.data_folder.length) throw new Error('Data folder path is empty! change config or environment variable!');
if (!config.default_admin_password.length) throw new Error('Default admin password is empty! are you asking to get hacked?');

await setupLogger(config.log_level);
await ensureDir(config.data_folder)

registerTempDirCleanup();
const database = await Deno.openKv(path.join(config.data_folder as string, 'dinosonic.db'));
setConstants(database, config);

async function cleanupNowPlaying() {
    const allNowPlaying = await database.list({ prefix: ['nowPlaying'] });

    for await (const entry of allNowPlaying) {
        const item = entry.value as nowPlaying;

        // If missing required fields, delete immediately
        if (!item || !item.minutesAgo || !item.track.duration) {
            await database.delete(entry.key);
            logger.warn(`Removed invalid nowPlaying entry for ${entry.key}`);
            continue;
        }

        const minutesAgo = Math.floor((Date.now() - item.minutesAgo.getTime()) / (1000 * 60));

        // Remove if it's been 10 minutes or longer than the song duration
        if (minutesAgo > Math.ceil(item.track.duration / 60)) {
            await database.delete(entry.key);
            logger.debug(`Removed stale nowPlaying entry for ${item.username}`);
        }
    }
}

// Run cleanup every minute
setInterval(cleanupNowPlaying, 60 * 1000);
cleanupNowPlaying();

await ensureAdminUserExistsHybrid();

if (config.scan_on_start) {
    logger.info('Starting media scan...');
    scanMediaDirectories(config.music_folders);
}

setInterval(() => {
    logger.info('Starting media scan..');
    scanMediaDirectories(config.music_folders, true, true);
}, parseTimeToMs(config.scan_interval));

logger.info('🚀 Starting Dinosonic server...');
const app = new Hono();

app.use(
    '*',
    cors({
        origin: '*',
        allowMethods: ['GET', 'POST'],
        allowHeaders: ['Content-Type', 'Authorization'],
    }),
);

app.use('*', async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    const duration = Date.now() - start;
    logger.debug(`[${c.req.method} (${c.res.status})] ${c.req.url} - ${duration}ms`);
});

app.use('/api/*', authMiddleware);
app.use('/admin/*', authMiddleware);
app.use('/public/*', serveStatic({ root: new URL('./client/', import.meta.url).pathname }));

app.route('/rest', restRoutes);
app.route('/api', apiRoutes);

app.get('/favicon.ico', (c: Context) => c.redirect('/public/favicon.ico'));
app.get('/admin/login', async (c: Context) => {
    try {
        const content = await Deno.readTextFile(new URL('./client/admin/login.html', import.meta.url));
        return c.html(content);
    } catch (error) {
        console.error('Error loading login page:', error);
        return c.text('Error loading page', 500);
    }
});

app.get('/admin/', async (c: Context) => {
    try {
        const content = await Deno.readTextFile(new URL('./client/admin/index.html', import.meta.url));
        return c.html(content);
    } catch (error) {
        console.error('Error loading admin page:', error);
        return c.text('Error loading page', 500);
    }
});

app.get('/share/:shareId', async (c: Context) => {
    const { shareId } = c.req.param();
    const requestUrl = new URL(c.req.url);
    const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

    const shareEntry = await database.get(['shares', shareId]);

    if (!shareEntry.value) {
        logger.warn(`Share ID ${shareId} not found for /share/ page.`);
        return c.text('Share not found or has expired.', 404);
    }

    const shareParseResult = ShareSchema.safeParse(shareEntry.value);
    if (!shareParseResult.success) {
        logger.error(`Malformed share data in DB for ID ${shareId}`);
        return c.text('Invalid share data.', 500);
    }
    const share = shareParseResult.data;

    if (share.expires && new Date(share.expires) < new Date()) {
        logger.info(`Share ID ${shareId} has expired. Deleting.`);
        await database.delete(['shares', shareId]); // Optionally delete expired shares
        return c.text('Share has expired.', 410); // 410 Gone
    }

    // Increment view count and update last viewed (can be done here or in /api/public-share-details)
    // Doing it here means even direct page loads (by crawlers) are counted.
    share.viewCount = (share.viewCount || 0) + 1;
    share.lastViewed = new Date();
    await database.set(['shares', shareId], share); // Save updated share

    // Fetch item details based on share.itemType
    let item: Song | Album | Playlist | CoverArt | null = null; // Use specific types
    let ownerUsername = 'Unknown User';

    const ownerEntry = await database.get(['users', share.userId]);
    if (ownerEntry.value) {
        const owner = UserSchema.parse(ownerEntry.value);
        ownerUsername = owner.subsonic.username;
    }

    switch (share.itemType) {
        case 'song': {
            const songVal = (await database.get(['tracks', share.itemId])).value;
            if (songVal) item = SongSchema.parse(songVal);
            break;
        }
        case 'album': {
            const albumVal = (await database.get(['albums', share.itemId])).value;
            if (albumVal) item = AlbumSchema.parse(albumVal);
            break;
        }
        case 'playlist': {
            const plVal = (await database.get(['playlists', share.itemId])).value;
            if (plVal) item = PlaylistSchema.parse(plVal);
            break;
        }
        case 'coverArt': {
            const coverVal = (await database.get(['covers', share.itemId])).value;
            if (coverVal) item = CoverArtSchema.parse(coverVal);
            break;
        }
    }

    if (!item) {
        logger.warn(`Shared item ${share.itemId} (type: ${share.itemType}) not found for share page ${shareId}.`);
        return c.text('Shared item not found.', 404);
    }

    // Prepare meta tag content
    let metaTitle = 'Dinosonic Share';
    let metaDescription = share.description || `Content shared by ${ownerUsername} via Dinosonic.`;
    let metaImageUrl: string | undefined = undefined;
    let metaOgType = 'website';

    if (share.itemType === 'song' && item && 'subsonic' in item) {
        item = item as Song;
        metaTitle = `${item.subsonic.title || 'Song'} by ${item.subsonic.artist || 'Unknown Artist'}`;
        metaDescription = share.description ||
            `Listen to ${item.subsonic.title} on Dinosonic. Shared by ${ownerUsername}. Album: ${item.subsonic.album || 'N/A'}.`;
        if (item.subsonic.coverArt) metaImageUrl = `${baseUrl}/api/public-cover/${item.subsonic.coverArt}?size=600`;
        metaOgType = 'music.song';
    } else if (share.itemType === 'album' && item && 'subsonic' in item) {
        item = item as Album;
        metaTitle = `${item.subsonic.name || 'Album'} by ${item.subsonic.artist || 'Unknown Artist'}`;
        metaDescription = share.description ||
            `Check out the album "${item.subsonic.name}" by ${item.subsonic.artist || 'Unknown Artist'} on Dinosonic. Shared by ${ownerUsername}.`;
        if (item.subsonic.coverArt) metaImageUrl = `${baseUrl}/api/public-cover/${item.subsonic.coverArt}?size=600`;
        metaOgType = 'music.album';
    } else if (share.itemType === 'playlist' && item && 'name' in item) { // Playlist type check
        item = item as Playlist;
        metaTitle = `Playlist: ${item.name || 'Shared Playlist'}`;
        metaDescription = share.description || `Listen to the playlist "${item.name}" on Dinosonic. Shared by ${ownerUsername}.`;
        if (item.coverArt) metaImageUrl = `${baseUrl}/api/public-cover/${item.coverArt}?size=600`;
        else if (item.entry && item.entry.length > 0) { // Fallback to first song's cover
            const firstSongId = typeof item.entry[0] === 'string' ? item.entry[0] : (item.entry[0] as { id: string }).id;
            const firstSongEntry = (await database.get(['tracks', firstSongId])).value;
            if (firstSongEntry) {
                const firstSong = SongSchema.parse(firstSongEntry);
                if (firstSong.subsonic.coverArt) metaImageUrl = `${baseUrl}/api/public-cover/${firstSong.subsonic.coverArt}?size=600`;
            }
        }
        metaOgType = 'music.playlist';
    } else if (share.itemType === 'coverArt' && item && 'id' in item) {
        metaTitle = share.description || `Shared Image from Dinosonic`;
        metaDescription = `View image shared by ${ownerUsername} on Dinosonic.`;
        metaImageUrl = `${baseUrl}/api/public-cover/${item.id}?size=1200`; // Item ID is the cover ID
        metaOgType = 'og:image';
    }

    // Construct meta tags string
    let metaTagsHtml = `
        <meta property="og:title" content="${metaTitle.replace(/"/g, '"')}">
        <meta property="og:description" content="${metaDescription.replace(/"/g, '"')}">
        <meta property="og:url" content="${baseUrl}/share/${shareId}">
        <meta property="og:site_name" content="Dinosonic">
        <meta property="og:type" content="${metaOgType}">
        <meta name="twitter:title" content="${metaTitle.replace(/"/g, '"')}">
        <meta name="twitter:description" content="${metaDescription.replace(/"/g, '"')}">
    `;
    if (metaImageUrl) {
        metaTagsHtml += `
        <meta property="og:image" content="${metaImageUrl}">
        <meta property="og:image:width" content="600">
        <meta property="og:image:height" content="600">
        <meta name="twitter:image" content="${metaImageUrl}">
        <meta name="twitter:card" content="summary_large_image">`;
    } else {
        metaTagsHtml += `
        <meta name="twitter:card" content="summary">`;
    }
    // Add music specific tags if applicable (simplified for brevity here, can be expanded)
    if (metaOgType === 'music.song' && item && 'subsonic' in item) {
        item = item as Song;
        if (item.subsonic.artist) metaTagsHtml += `<meta property="music:musician" content="${item.subsonic.artist.replace(/"/g, '"')}">`;
        if (item.subsonic.album) metaTagsHtml += `<meta property="music:album" content="${item.subsonic.album.replace(/"/g, '"')}">`;
    } // etc. for album, playlist

    try {
        let htmlContent = await Deno.readTextFile(new URL('./client/share/share.html', import.meta.url));
        // Replace a placeholder in share.html with the dynamic meta tags and page title
        htmlContent = htmlContent.replace(
            /<title>Dinosonic Share<\/title>/,
            `<title>${metaTitle.replace(/</g, '<').replace(/>/g, '>')} - Dinosonic Share</title>${metaTagsHtml}`,
        );
        // Optionally, inject initial data to avoid a second API call from client-side JS,
        // though the current share.html JS fetches it anyway.
        // For example: htmlContent = htmlContent.replace('<!-- INITIAL_DATA_PLACEHOLDER -->', `<script>window.__INITIAL_SHARE_DATA__ = ${JSON.stringify({share, item, ownerUsername})};</script>`);

        return c.html(htmlContent);
    } catch (error) {
        logger.error('Error reading or processing share.html template:', error);
        return c.text('Error loading share page', 500);
    }
});

if (config.ui_folder) {
    try {
        const uiStat = await Deno.stat(config.ui_folder);
        if (!uiStat.isDirectory) {
            throw new Error(`The specified UI path is not a directory: ${config.ui_folder}`);
        }
        logger.info(`Serving static UI from: ${config.ui_folder}`);

        app.get(
            '*',
            serveStatic({
                root: config.ui_folder,
                rewriteRequestPath: (reqPath) => {
                    const fullPath = path.join(config.ui_folder ?? '', reqPath);
                    try {
                        const stats = Deno.statSync(fullPath);
                        if (stats.isFile || stats.isDirectory) {
                            return reqPath;
                        }
                    } catch {
                        // File doesn't exist
                    }
                    return 'index.html';
                },
            }),
        );
        // deno-lint-ignore no-explicit-any
    } catch (error: any) {
        if (error instanceof Deno.errors.NotFound) {
            logger.error(`The specified UI directory does not exist: ${config.ui_folder}`);
        } else {
            logger.error(`Error setting up static UI serving: ${error.message}`);
        }
        logger.info('Falling back to default root handler.');
        app.get('/', (c: Context) => c.text('Dinosonic Subsonic Server is running!'));
    }
} else {
    app.get('/', (c: Context) => c.text('Dinosonic Subsonic Server is running!'));
}

const port = config.port ?? 4100;
Deno.serve({ port, hostname: '0.0.0.0' }, app.fetch);

logger.info(`🌍 Server running on http://localhost:${port}`);
