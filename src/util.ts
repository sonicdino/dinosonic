import { stringify } from 'xml';
import { md5 } from 'md5';
import { encodeHex } from 'hex';
import { Context } from 'hono';
import type { Config, Playlist, SubsonicUser, User } from './zod.ts';
import * as log from 'log';
import { blue, bold, gray, red, yellow } from 'colors';

const SERVER_NAME = 'Dinosonic';
export const SERVER_VERSION = '0.0.21';
const API_VERSION = '1.16.1';
export let database: Deno.Kv;
export let config: Config;
export let logger = log.getLogger();

let ENCRYPTION_KEY: Promise<CryptoKey>;

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

export async function getNextId(type: 't' | 'a' | 'A' | 'p'): Promise<string> {
    const idKey = ['counters', type];
    const lastId = (await database.get(idKey)).value as number || 0;
    const newId = lastId + 1;
    await database.set(idKey, newId);
    return `${type}${newId}`;
}

export function setConstants(Database: Deno.Kv, Config: Config) {
    config = Config;
    database = Database;
    ENCRYPTION_KEY = getOrCreateEncryptionKey();
    return;
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

export async function updateUsernameReferences(oldUsername: string, newUsername: string) {
    const existingUser = await database.get(['users', newUsername.toLowerCase()]);
    if (existingUser.value) throw new Error(`Username '${newUsername}' is already taken.`);

    const txn = database.atomic();

    // Move userData entries
    for await (const entry of database.list({ prefix: ['userData', oldUsername.toLowerCase()] })) {
        txn.set(['userData', newUsername.toLowerCase(), ...entry.key.slice(2)], entry.value);
        txn.delete(entry.key);
    }

    // Move play queue
    const playQueue = await database.get(['playQueue', oldUsername.toLowerCase()]);
    if (playQueue.value) {
        txn.set(['playQueue', newUsername.toLowerCase()], playQueue.value);
        txn.delete(playQueue.key);
    }

    // Move now playing entries
    for await (const entry of database.list({ prefix: ['nowPlaying', oldUsername.toLowerCase()] })) {
        txn.set(['nowPlaying', newUsername.toLowerCase(), ...entry.key.slice(2)], entry.value);
        txn.delete(entry.key);
    }

    // Update playlists where owner is the old username
    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;
        if (playlist.owner.toLowerCase() === oldUsername.toLowerCase()) {
            playlist.owner = newUsername;
            txn.set(entry.key, playlist);
        }
    }

    // Delete the old user entry
    txn.delete(['users', oldUsername.toLowerCase()]);

    // Commit transaction
    await txn.commit();
}

export async function deleteUserReferences(username: string) {
    const txn = database.atomic();

    // Delete user entry
    txn.delete(['users', username]);

    // Delete userData entries
    for await (const entry of database.list({ prefix: ['userData', username] })) {
        txn.delete(entry.key);
    }

    // Delete play queue
    txn.delete(['playQueue', username]);

    // Delete now playing entries
    for await (const entry of database.list({ prefix: ['nowPlaying', username] })) {
        txn.delete(entry.key);
    }

    // Delete playlists owned by the user
    for await (const entry of database.list({ prefix: ['playlists'] })) {
        const playlist = entry.value as Playlist;
        if (playlist.owner === username) {
            txn.delete(entry.key);
        }
    }

    // Commit transaction
    await txn.commit();
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
        await ENCRYPTION_KEY,
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
        await ENCRYPTION_KEY,
        ciphertext,
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
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
    const user = (await database.get(['users', username.toLowerCase()])).value as User | null;
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
        if (password.startsWith('enc:')) {
            plainPassword = atob(password.slice(4));
        }

        // Compare with stored hash
        const originalPassword = await decryptForTokenAuth(user.backend.password);
        if (originalPassword !== plainPassword) {
            return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        }

        return user.subsonic;
    }

    return createResponse(c, {}, 'failed', { code: 42, message: ERROR_MESSAGES[42] });
}
