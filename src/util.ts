import { stringify } from 'xml';
import { md5 } from 'md5';
import { encodeHex } from 'hex';
import { Context } from 'hono';
import type { User } from './zod.ts';
import * as log from 'log';
import { blue, bold, gray, red, yellow } from 'colors';

const SERVER_NAME = 'Dinosonic';
export const SERVER_VERSION = '1.0.0';
const API_VERSION = '1.16.1';
export let database: Deno.Kv;
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

    logger = log.getLogger();
}

export function setDatabase(Database: Deno.Kv) {
    return database = Database;
}

export function separatorsToRegex(separators: string[]): RegExp {
    const escaped = separators.map((sep) => `\\${sep}`).join('|');

    return new RegExp(`[${escaped}]+`);
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
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return false; // Path does not exist
        } else {
            throw error; // Other errors (e.g., permission denied)
        }
    }
}

/**
 * Creates a standardized OpenSubsonic response
 */
export function createResponse(
    c: Context,
    data: Record<string, unknown> = {},
    status: 'ok' | 'failed' = 'ok',
    error?: { code: number; message: string },
) {
    const format = c.req.query('f') || 'xml';
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

export async function validateAuth(c: Context): Promise<Response | { username: string }> {
    const username = c.req.query('u');
    const password = c.req.query('p');
    const token = c.req.query('t');
    const salt = c.req.query('s');

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: ERROR_MESSAGES[10] });

    // 🔍 Get user from the database
    const user = (await database.get(['users', username])).value as User | null;
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });

    // ✅ Token Authentication
    if (token && salt) {
        const expectedToken = generateTokenHash(user.backend.password, salt);
        if (expectedToken !== token) return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
        return { username };
    }

    // ✅ Basic Authentication
    if (password) {
        if (password.startsWith('enc:')) {
            const decodedPassword = atob(password.slice(4));
            if (decodedPassword !== user.backend.password) {
                return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
            }
        } else {
            if (password !== user.backend.password) {
                return createResponse(c, {}, 'failed', { code: 40, message: ERROR_MESSAGES[40] });
            }
        }
        return { username };
    }

    return createResponse(c, {}, 'failed', { code: 42, message: ERROR_MESSAGES[42] });
}
