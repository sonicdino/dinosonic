import { stringify } from '@libs/xml';
import { md5 } from '@takker/md5';
import { encodeHex } from '@std/encoding';
import { Context } from '@hono/hono';
import { type Config, Playlist, type SubsonicUser, type User, UserSchema } from './zod.ts';
import * as log from '@std/log';
import { blue, bold, gray, red, yellow } from '@std/fmt/colors';

const SERVER_NAME = 'Dinosonic';
const API_VERSION = '1.16.1';
export const SERVER_VERSION = '0.1.2';
export let database: Deno.Kv;
export let config: Config;
export let logger = log.getLogger();

export const ERROR_MESSAGES: Record<number, string> = {
    0: 'A generic error.',
    10: 'Required parameter is missing.',
    20: 'Incompatible Subsonic REST protocol version. Client must upgrade.',
    30: 'Incompatible Subsonic REST protocol version. Server must upgrade.',
    40: 'Wrong username or password.',
    41: 'Token authentication not supported for LDAP users.',
    42: 'Provided authentication mechanism not supported.',
    43: 'Multiple conflicting authentication mechanisms provided.',
    44: 'Invalid API key.',
    50: 'User is not authorized for the given operation.',
    60: 'The trial period for the Subsonic server is over. Please upgrade.',
    70: 'The requested data was not found.',
};

function generateTokenHash(password: string, salt: string): string {
    return encodeHex(md5(password + salt));
}

function logFormatter(logRecord: log.LogRecord): string {
    const timestamp = new Date().toLocaleTimeString();
    let levelColor;
    switch (logRecord.levelName) {
        case 'INFO':
            levelColor = blue;
            break;
        case 'DEBUG':
            levelColor = gray;
            break;
        case 'WARNING':
            levelColor = yellow;
            break;
        case 'ERROR':
            levelColor = red;
            break;
        default:
            levelColor = bold;
    }
    return `${bold(timestamp)} [${levelColor(logRecord.levelName)}] ${logRecord.msg}`;
}

export async function setupLogger(logLevel: string) {
    logLevel = logLevel.toUpperCase();

    if (logLevel === 'OFF') {
        await log.setup({
            handlers: {},
            loggers: {
                default: {
                    level: 'NOTSET',
                    handlers: [],
                },
            },
        });
    } else {
        await log.setup({
            handlers: {
                console: new log.ConsoleHandler(logLevel as log.LevelName, {
                    formatter: logFormatter,
                }),
            },
            loggers: {
                default: {
                    level: logLevel as log.LevelName,
                    handlers: ['console'],
                },
            },
        });
    }

    logger = log.getLogger();
}

export async function checkInternetConnection() {
    try {
        // Try to fetch a reliable external resource with a timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch('https://dns.google.com/resolve?name=example.com', {
            signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) return true;

        return false;
    } catch (_) {
        return false;
    }
}

export async function generateId(): Promise<string> {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    // Hash the random bytes with SHA-256
    const hashBuffer = await crypto.subtle.digest('SHA-256', randomBytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    // Pick a random start position and take 30 characters
    const maxStart = hashHex.length - 30;
    const start = Math.floor(Math.random() * (maxStart + 1));
    return hashHex.slice(start, start + 30);
}

export function setConstants(Database: Deno.Kv, Config: Config) {
    config = Config;
    return database = Database;
}

export function separatorsToRegex(separators: string[]): RegExp {
    const escaped = separators.map((sep) => `\\${sep}`).join('|');

    return new RegExp(`[${escaped}]+`);
}

export async function getFields(c: Context, fieldName: string) {
    if (c.req.method === 'GET') return c.req.queries(fieldName);
    else if (c.req.method === 'POST') {
        const body = await c.req.parseBody();
        const values: string[] = [];
        Object.keys(body).forEach((key) => {
            const match = key.match(new RegExp(`^${fieldName}\\[(\\d+)\\]$`)); // Match id[0], id[1]
            if (match) values[parseInt(match[1], 10)] = body[key] as string; // Store in correct order
        });

        if (values.length > 0) return values;

        const value = body[fieldName];
        return Array.isArray(value) ? value : value !== undefined ? [value] : undefined;
    }
    return;
}

export async function getField(c: Context, fieldName: string) {
    if (c.req.method === 'GET') return c.req.query(fieldName);
    else if (c.req.method === 'POST') {
        const body = await c.req.parseBody();
        return body[fieldName] as string | undefined;
    }
    return;
}

/**
 * Check if a directory of file exists.
 * @param path Path of the file/dir to check
 * @returns boolean
 */
export async function exists(path: string): Promise<boolean> {
    try {
        await Deno.stat(path);
        return true; // Path exists
    } catch (_) {
        return false;
    }
}

export function parseTimeToMs(timeStr: string): number {
    const timeUnits: Record<string, number> = {
        s: 1000, // seconds
        m: 60 * 1000, // minutes
        h: 60 * 60 * 1000, // hours
        d: 24 * 60 * 60 * 1000, // days
    };

    return timeStr.split(' ').reduce((total, part) => {
        const match = part.match(/(\d+)([smhd])/);
        if (match) {
            const [, num, unit] = match;
            return total + parseInt(num) * timeUnits[unit];
        }
        return total;
    }, 0);
}

export async function getSessionKey(token: string): Promise<string | null> {
    if (config.last_fm && config.last_fm.api_key && config.last_fm.api_secret) {
        const sig = new URLSearchParams({
            api_key: config.last_fm.api_key,
            method: 'auth.getSession',
            token,
        });

        sig.append('api_sig', signParams(sig, config.last_fm.api_secret));

        const res = await fetch(
            `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${config.last_fm.api_key}&format=json&${sig}`,
        );
        const data = await res.json();
        return data.session?.key || null;
    }

    return null;
}

export function signParams(params: URLSearchParams, apiSecret: string): string {
    const sortedKeys = [...params.keys()].sort(); // Sort keys alphabetically
    let signatureBase = '';

    for (const key of sortedKeys) {
        if (key !== 'format' && key !== 'api_sig') { // Exclude format & api_sig
            signatureBase += key + params.get(key);
        }
    }

    signatureBase += apiSecret; // Append API secret at the end

    return encodeHex(md5(signatureBase)); // Hash with MD5
}

export async function ensureAdminUserExistsHybrid() {
    const adminSetupFlagKey: Deno.KvKey = ['system', 'initialAdminCreated'];
    const adminSetupFlagEntry = await database.get(adminSetupFlagKey);
    const initialAdminShouldExist = adminSetupFlagEntry.value === true;
    let actualAdminExists = false;

    if (initialAdminShouldExist) {
        logger.info('Initial admin setup flag is present. Verifying actual admin existence...');
        // Verify by iterating and checking for adminRole
        for await (const entry of database.list({ prefix: ['users'] })) {
            const userParseResult = UserSchema.safeParse(entry.value);
            if (userParseResult.success && userParseResult.data.subsonic.adminRole === true) {
                actualAdminExists = true;
                logger.info(`Verified admin user: ${userParseResult.data.subsonic.username} (ID: ${userParseResult.data.backend.id})`);
                break;
            }
        }
        if (!actualAdminExists) {
            logger.warn('Admin setup flag was true, but no actual admin user found! This indicates an inconsistency.');
            // Proceed to recreate the admin as if the flag was false.
            // Optionally, you could just log an error and require manual intervention here.
        }
    }

    // If flag wasn't set OR (flag was set BUT no admin was actually found)
    if (!initialAdminShouldExist || (initialAdminShouldExist && !actualAdminExists)) {
        if (!initialAdminShouldExist) {
            logger.info('Initial admin setup flag not found or false. Creating admin user.');
        } else {
            logger.info('Admin setup flag was true, but verification failed. Recreating admin user.');
        }

        const adminId = await generateId();
        const adminUsername = 'admin'; // Use a configurable default username
        const adminPassword = config.default_admin_password;

        const newAdminUser: User = {
            backend: {
                id: adminId,
                username: adminUsername,
                password: await encryptForTokenAuth(adminPassword),
            },
            subsonic: {
                username: adminUsername,
                adminRole: true,
                scrobblingEnabled: true,
                settingsRole: true,
                downloadRole: true,
                uploadRole: true,
                playlistRole: true,
                coverArtRole: true,
                commentRole: true,
                podcastRole: true,
                streamRole: true,
                jukeboxRole: false,
                shareRole: false,
            },
        };

        const validationResult = UserSchema.safeParse(newAdminUser);
        if (validationResult.success) {
            await database.set(['users', adminId], validationResult.data);
            await database.set(adminSetupFlagKey, true); // Ensure flag is set (or re-set)
            logger.info(`Admin user "${adminUsername}" created/recreated with ID: ${adminId}. Setup flag is now true.`);
        } else {
            logger.error('Failed to validate new admin user data. Admin not created/recreated.');
            logger.error('Validation errors:', validationResult.error.issues);
            // If creation fails, ensure the flag is not incorrectly true
            if (initialAdminShouldExist && !actualAdminExists) {
                // Consider setting the flag to false if recreation fails, so it tries again next time.
                // await database.set(adminSetupFlagKey, false);
            }
        }
    } else {
        // This means: initialAdminShouldExist was true AND actualAdminExists was true.
        logger.info('Admin user verified and exists. No action needed.');
    }
}

// TODO: If these functions can be further improved, improve.
export async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
    // Check if we have a stored key in the database
    const keyData = (await database.get(['system', 'encryptionKey'])).value as string | undefined;

    if (keyData) {
        // If we have a stored key, import it
        const keyBuffer = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));
        return await crypto.subtle.importKey(
            'raw',
            keyBuffer,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt'],
        );
    } else {
        // If we don't have a stored key, create a new one
        const newKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true, // extractable
            ['encrypt', 'decrypt'],
        );

        // Export the key to store it
        const exportedKey = await crypto.subtle.exportKey('raw', newKey);
        const keyBuffer = new Uint8Array(exportedKey);
        const keyString = btoa(String.fromCharCode(...keyBuffer));

        // Store the key in the database
        await database.set(['system', 'encryptionKey'], keyString);

        return newKey;
    }
}

// Function to encrypt password for token auth
export async function encryptForTokenAuth(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const encryptedData = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await getOrCreateEncryptionKey(),
        data,
    );

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encryptedData.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encryptedData), iv.length);

    return btoa(String.fromCharCode(...combined));
}

// Function to decrypt password for token auth
export async function decryptForTokenAuth(encryptedData: string): Promise<string> {
    const combined = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await getOrCreateEncryptionKey(),
        ciphertext,
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

export async function deleteUserReferences(id: string) {
    const txn = database.atomic();

    // Delete user entry
    txn.delete(['users', id]);

    // Delete userData entries
    for await (const entry of database.list({ prefix: ['userData', id] })) {
        txn.delete(entry.key);
    }

    // Delete play queue
    txn.delete(['playQueue', id]);

    // Delete now playing entries
    for await (const entry of database.list({ prefix: ['nowPlaying', id] })) {
        txn.delete(entry.key);
    }

    // Delete playlists owned by the user
    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;
        if (playlist.owner === id) {
            txn.delete(entry.key);
        }
    }

    // Commit transaction
    await txn.commit();
}

export function hexToString(hex: string): string {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    return new TextDecoder().decode(bytes);
}

export async function getUserByUsername(name: string): Promise<User | undefined> {
    for await (const entry of database.list({ prefix: ['users'] })) {
        const parsedEntry = UserSchema.safeParse(entry.value as User | null);
        if (parsedEntry.success) {
            const user = parsedEntry.data;
            if (user.backend.username === name.toLowerCase().trim()) return user;
        }
    }
}

/**
 * Creates a standardized OpenSubsonic response
 */
export async function createResponse(
    c: Context,
    data: Record<string, unknown> = {},
    status: 'ok' | 'failed' = 'ok',
    error?: { code: number; message: string },
) {
    const format = await getField(c, 'f') || 'xml';
    const responseData = {
        'subsonic-response': {
            status,
            version: API_VERSION,
            type: SERVER_NAME,
            serverVersion: SERVER_VERSION,
            openSubsonic: true,
            ...data,
            ...(error ? { error } : {}),
        },
    };

    if (format.includes('xml')) {
        const xmlResponse = stringify(responseData);
        return c.text(xmlResponse, error ? 400 : 200, { 'Content-Type': 'application/xml' });
    }

    return c.json(responseData, error ? 400 : 200);
}

export async function validateAuth(c: Context): Promise<Response | SubsonicUser> {
    const username = await getField(c, 'u');
    const password = await getField(c, 'p');
    const token = await getField(c, 't');
    const salt = await getField(c, 's');
    const client = await getField(c, 'c');

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'u'" });
    if (!client) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'c'" });

    // 🔍 Get user from the database
    const user = await getUserByUsername(username);
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });

    // ✅ Token Authentication
    if (token && salt) {
        // Decrypt the stored password to use for token generation
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        const expectedToken = generateTokenHash(originalPassword, salt);

        if (expectedToken !== token) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }
        return user.subsonic;
    }

    // ✅ Basic Authentication
    if (password) {
        let plainPassword = password;

        // Handle encoded passwords
        if (password.startsWith('enc:')) plainPassword = hexToString(password.slice(4));

        // Compare with stored hash
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        if (originalPassword !== plainPassword) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }

        return user.subsonic;
    }

    return createResponse(c, {}, 'failed', { code: 42, message: ERROR_MESSAGES[42] });
}
