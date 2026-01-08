import { stringify } from '@libs/xml';
import { md5 } from '@takker/md5';
import { encodeHex } from '@std/encoding';
import { Context } from '@hono/hono';
import { type Config, Playlist, Share, type SubsonicUser, type User, UserSchema } from './zod.ts';
import * as log from '@std/log';
import { blue, bold, gray, red, yellow } from '@std/fmt/colors';
import { existsSync } from 'node:fs';

const SERVER_NAME = 'Dinosonic';
const API_VERSION = '1.16.1';
export const SERVER_VERSION = '0.5.4';

export let database: Deno.Kv;
export let config: Config;
export let logger = log.getLogger();

/**
 * A map of Subsonic API error codes to their corresponding messages.
 */
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

/**
 * Generates an MD5 hash for token-based authentication.
 * @param password The user's password.
 * @param salt A random string (salt).
 * @returns The hex-encoded MD5 hash of the password concatenated with the salt.
 */
function generateTokenHash(password: string, salt: string): string {
    return encodeHex(md5(password + salt));
}

/**
 * Formats a log record with a timestamp and color-coded level.
 * @param logRecord The log record to format.
 * @returns A formatted log string.
 */
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

/**
 * Configures the global logger based on the specified log level.
 * @param logLevel The desired log level (e.g., 'INFO', 'DEBUG', 'OFF').
 */
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

/**
 * Checks for an active internet connection by attempting to resolve a domain.
 * @returns A promise that resolves to `true` if the connection is successful, `false` otherwise.
 */
export async function checkInternetConnection(): Promise<boolean> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch('https://dns.google.com/resolve?name=example.com', {
            signal: controller.signal,
        });

        clearTimeout(timeout);
        return response.ok;
    } catch (_) {
        return false;
    }
}

/**
 * Generates a cryptographically random ID string of a specified length.
 * @param length The desired length of the ID. Defaults to 30.
 * @returns A promise that resolves to the generated ID string.
 */
export async function generateId(length = 30): Promise<string> {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);

    const hashBuffer = await crypto.subtle.digest('SHA-256', randomBytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const maxStart = hashHex.length - length;
    const start = Math.floor(Math.random() * (maxStart + 1));
    return hashHex.slice(start, start + length);
}

/**
 * Initializes global constants for the database and configuration.
 * @param Database The Deno.Kv instance to use.
 * @param Config The application configuration object.
 * @returns The initialized Deno.Kv instance.
 */
export function setConstants(Database: Deno.Kv, Config: Config) {
    config = Config;
    getTempDir(); // Eagerly create the temp directory on startup
    return database = Database;
}

/**
 * Converts an array of separator characters into a single regular expression.
 * @param separators An array of strings to be used as separators.
 * @returns A RegExp that matches one or more of the specified separators.
 */
export function separatorsToRegex(separators: string[]): RegExp {
    const escaped = separators.map((sep) => `\\${sep}`).join('|');
    return new RegExp(`[${escaped}]+`);
}

/**
 * Retrieves all values for a given field name from a request context.
 * Supports both GET (query parameters) and POST (form body).
 * @param c The Hono context object.
 * @param fieldName The name of the field to retrieve.
 * @returns A promise that resolves to an array of strings or undefined if not found.
 */
export async function getFields(c: Context, fieldName: string): Promise<string[] | undefined> {
    if (c.req.method === 'GET') {
        return c.req.queries(fieldName);
    } else if (c.req.method === 'POST') {
        const body = await c.req.parseBody();
        const values: string[] = [];

        // Handle array syntax like 'fieldName[0]', 'fieldName[1]'
        Object.keys(body).forEach((key) => {
            const match = key.match(new RegExp(`^${fieldName}\\[(\\d+)\\]$`));
            if (match) {
                values[parseInt(match[1], 10)] = body[key] as string;
            }
        });

        if (values.length > 0) return values;

        // Handle repeated field names or a single field
        const value = body[fieldName];
        return Array.isArray(value) ? value : value !== undefined ? [value as string] : undefined;
    }
}

/**
 * Retrieves a single value for a given field name from a request context.
 * @param c The Hono context object.
 * @param fieldName The name of the field to retrieve.
 * @returns A promise that resolves to the field's value as a string, or undefined if not found.
 */
export async function getField(c: Context, fieldName: string): Promise<string | undefined> {
    if (c.req.method === 'GET') {
        return c.req.query(fieldName);
    } else if (c.req.method === 'POST') {
        const body = await c.req.parseBody();
        return body[fieldName] as string | undefined;
    }
}

/**
 * Parses a time string (e.g., "1d 12h 30m") into milliseconds.
 * @param timeStr The time string to parse. Supported units: s, m, h, d.
 * @returns The total time in milliseconds.
 */
export function parseTimeToMs(timeStr: string): number {
    const timeUnits: Record<string, number> = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
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

/**
 * Gets or creates a singleton temporary directory for the application.
 * @returns A promise that resolves to the path of the temporary directory.
 */
export async function getTempDir(): Promise<string> {
    if (!globalThis.__tmpDir) {
        globalThis.__tmpDir = await Deno.makeTempDir({ prefix: 'dinosonic_' });
    }
    return globalThis.__tmpDir;
}

declare global {
    var __tmpDir: string;
}

/**
 * Registers cleanup handlers to remove the temporary directory on process exit.
 */
export function registerTempDirCleanup() {
    const cleanup = async () => {
        if (globalThis.__tmpDir && existsSync(globalThis.__tmpDir)) {
            try {
                await Deno.remove(globalThis.__tmpDir, { recursive: true });
                console.log('Temporary directory cleaned up:', globalThis.__tmpDir);
            } catch (err) {
                console.warn('Failed to clean up temp dir:', err);
            }
        }
        Deno.exit();
    };

    Deno.addSignalListener('SIGINT', cleanup);
    Deno.addSignalListener('SIGTERM', cleanup);
    addEventListener('unload', () => {
        if (globalThis.__tmpDir && existsSync(globalThis.__tmpDir)) {
            Deno.removeSync(globalThis.__tmpDir, { recursive: true });
        }
    });
}

/**
 * Retrieves a Last.fm session key using a temporary token.
 * @param token The temporary token from Last.fm's auth flow.
 * @returns A promise that resolves to the session key or null if it fails.
 */
export async function getSessionKey(token: string): Promise<string | null> {
    if (config.last_fm?.api_key && config.last_fm?.api_secret) {
        const params = new URLSearchParams({
            api_key: config.last_fm.api_key,
            method: 'auth.getSession',
            token,
        });

        const api_sig = signParams(params, config.last_fm.api_secret);
        params.append('api_sig', api_sig);
        params.append('format', 'json');

        const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);
        const data = await res.json();
        return data.session?.key || null;
    }

    return null;
}

/**
 * Signs a set of Last.fm API parameters with the API secret.
 * @param params The URLSearchParams to sign.
 * @param apiSecret The Last.fm API secret.
 * @returns The generated MD5 signature string.
 */
export function signParams(params: URLSearchParams, apiSecret: string): string {
    const sortedKeys = [...params.keys()].sort();
    let signatureBase = '';

    for (const key of sortedKeys) {
        if (key !== 'format' && key !== 'api_sig') {
            signatureBase += key + params.get(key);
        }
    }

    signatureBase += apiSecret;

    return encodeHex(md5(signatureBase));
}

/**
 * Ensures that an admin user exists in the database.
 * @description This function checks a flag in the database to see if an admin should exist.
 * If the flag is set, it verifies an admin user is actually present. If the flag is not set,
 * or if the verification fails, it creates a new admin user with credentials from the config
 * and sets the flag.
 */
export async function ensureAdminUserExistsHybrid() {
    const adminSetupFlagKey: Deno.KvKey = ['system', 'initialAdminCreated'];
    const adminSetupFlagEntry = await database.get(adminSetupFlagKey);
    const initialAdminShouldExist = adminSetupFlagEntry.value === true;
    let actualAdminExists = false;

    if (initialAdminShouldExist) {
        logger.info('Initial admin setup flag is present. Verifying actual admin existence...');
        for await (const entry of database.list({ prefix: ['users'] })) {
            const userParseResult = UserSchema.safeParse(entry.value);
            if (userParseResult.success && userParseResult.data.subsonic.adminRole === true) {
                actualAdminExists = true;
                logger.info(`Verified admin user: ${userParseResult.data.subsonic.username}`);
                break;
            }
        }
        if (!actualAdminExists) {
            logger.warn('Admin setup flag was true, but no admin user was found! Recreating.');
        }
    }

    if (!initialAdminShouldExist || !actualAdminExists) {
        logger.info('Creating or recreating admin user.');

        const adminId = await generateId();
        const adminUsername = 'admin';
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
            await database.set(adminSetupFlagKey, true);
            logger.info(`Admin user "${adminUsername}" created successfully.`);
        } else {
            logger.error('Failed to validate new admin user data.', validationResult.error.issues);
        }
    } else {
        logger.info('Admin user verified and exists. No action needed.');
    }
}

/**
 * Retrieves the encryption key from the database, or creates and saves a new one if it doesn't exist.
 * @returns A promise that resolves to a CryptoKey for AES-GCM operations.
 */
export async function getOrCreateEncryptionKey(): Promise<CryptoKey> {
    const keyEntry = await database.get<string>(['system', 'encryptionKey']);

    if (keyEntry.value) {
        const keyBuffer = Uint8Array.from(atob(keyEntry.value), (c) => c.charCodeAt(0));
        return await crypto.subtle.importKey(
            'raw',
            keyBuffer,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt'],
        );
    } else {
        const newKey = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt'],
        );

        const exportedKey = await crypto.subtle.exportKey('raw', newKey);
        const keyBuffer = new Uint8Array(exportedKey);
        const keyString = btoa(String.fromCharCode(...keyBuffer));

        await database.set(['system', 'encryptionKey'], keyString);
        return newKey;
    }
}

/**
 * Encrypts a password string using AES-GCM.
 * @param password The plaintext password to encrypt.
 * @returns A promise that resolves to a base64 encoded string containing the IV and ciphertext.
 */
export async function encryptForTokenAuth(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await getOrCreateEncryptionKey();

    const encryptedData = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

    const combined = new Uint8Array(iv.length + encryptedData.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encryptedData), iv.length);

    return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypts a password string that was encrypted with `encryptForTokenAuth`.
 * @param encryptedData The base64 encoded string containing the IV and ciphertext.
 * @returns A promise that resolves to the original plaintext password.
 */
export async function decryptForTokenAuth(encryptedData: string): Promise<string> {
    const combined = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const key = await getOrCreateEncryptionKey();

    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

/**
 * Deletes a user and all of their associated data from the database in a single transaction.
 * @param id The ID of the user to delete.
 */
export async function deleteUserReferences(id: string) {
    const txn = database.atomic();

    txn.delete(['users', id]);

    for await (const entry of database.list({ prefix: ['userData', id] })) {
        txn.delete(entry.key);
    }
    for await (const entry of database.list({ prefix: ['nowPlaying'] })) {
        if (entry.key[1] === id) txn.delete(entry.key);
    }
    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;
        if (playlist.owner === id) txn.delete(entry.key);
    }
    for await (const entry of database.list({ prefix: ['shares'] })) {
        const share = entry.value as Share;
        if (share.userId === id) txn.delete(entry.key);
    }

    txn.delete(['playQueue', id]);

    await txn.commit();
}

/**
 * Converts a hex-encoded string to a UTF-8 string.
 * @param hex The hex string to convert.
 * @returns The decoded string.
 */
export function hexToString(hex: string): string {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    return new TextDecoder().decode(bytes);
}

/**
 * Finds a user in the database by their username (case-insensitive).
 * @param name The username to search for.
 * @returns A promise that resolves to the User object or undefined if not found.
 */
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
 * Creates a standardized OpenSubsonic response in either JSON or XML format.
 * @param c The Hono context object.
 * @param data The main data payload for the response.
 * @param status The status of the response, 'ok' or 'failed'.
 * @param error An optional error object if the status is 'failed'.
 * @returns A Response object formatted according to the client's request.
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
            ...(format.includes('xml') && { '@xmlns': 'http://subsonic.org/restapi' }),
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
        return c.text(xmlResponse, 200, { 'Content-Type': 'application/xml' });
    }

    return c.json(responseData, 200);
}

/**
 * Validates user authentication from a request context.
 * @description Supports password-based (plain or hex-encoded) and token-based authentication.
 * @param c The Hono context object.
 * @returns On success, a promise that resolves to the user's Subsonic profile and backend ID.
 * On failure, a promise that resolves to a formatted error Response object.
 */
export async function validateAuth(c: Context): Promise<Response | (SubsonicUser & { id: string })> {
    const username = await getField(c, 'u');
    const password = await getField(c, 'p');
    const token = await getField(c, 't');
    const salt = await getField(c, 's');
    const client = await getField(c, 'c');

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'u'" });
    if (!client) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'c'" });

    const user = await getUserByUsername(username);
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });

    // Token-based authentication
    if (token && salt) {
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        const expectedToken = generateTokenHash(originalPassword, salt);
        if (expectedToken !== token) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }
        return { ...user.subsonic, id: user.backend.id };
    }

    // Password-based authentication
    if (password) {
        const plainPassword = password.startsWith('enc:') ? hexToString(password.slice(4)) : password;
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        if (originalPassword !== plainPassword) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }
        return { ...user.subsonic, id: user.backend.id };
    }

    return createResponse(c, {}, 'failed', { code: 42, message: ERROR_MESSAGES[42] });
}