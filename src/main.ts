import { Config, ConfigSchema, nowPlaying } from './zod.ts';
import { scanMediaDirectories } from './MediaScanner.ts';
import { parseArgs } from '@std/cli';
import { ensureAdminUserExistsHybrid, logger, parseTimeToMs, SERVER_VERSION, setConstants, setupLogger } from './util.ts';
import restRoutes from './client/rest/index.ts';
import apiRoutes from './client/api/index.ts';
import { Context, Hono, Next } from '@hono/hono';
import { cors } from '@hono/hono/cors';
import { serveStatic } from '@hono/hono/deno';
import { parse } from '@std/toml';
import * as path from '@std/path';
import { authMiddleware } from './client/middleware.ts';
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

    if (Deno.env.get('DINO_TRANSCODING_ENABLED')) {
        conf.transcoding = {
            enabled: Deno.env.get('DINO_TRANSCODING_ENABLED') === 'true',
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

app.get('/favicon.ico', (c) => c.redirect('/public/favicon.ico'));
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

app.get('/', (c: Context) => c.text('Dinosonic Subsonic Server is running!'));

const port = config.port ?? 4100;
Deno.serve({ port, hostname: '0.0.0.0' }, app.fetch);

logger.info(`🌍 Server running on http://localhost:${port}`);
