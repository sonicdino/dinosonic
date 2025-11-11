import { MiddlewareHandler } from '@hono/hono';
import { deleteCookie, getCookies } from '@std/http/cookie';
import { create, verify } from '@zaubrik/djwt';
import { database } from '../util.ts';
import { SubsonicUser } from '../zod.ts';

const generateOrGetKey = async () => {
    const keyData = (await database.get(['system', 'jwtEncryptionKey'])).value as string | undefined;

    if (keyData) {
        const keyBuffer = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));
        return await crypto.subtle.importKey(
            'raw',
            keyBuffer,
            { name: 'HMAC', hash: 'SHA-512' },
            false,
            ['sign', 'verify'],
        );
    } else {
        const newKey = await crypto.subtle.generateKey(
            { name: 'HMAC', hash: 'SHA-512' },
            true,
            ['sign', 'verify'],
        );

        const exportedKey = await crypto.subtle.exportKey('raw', newKey);
        const keyBuffer = new Uint8Array(exportedKey);
        const keyString = btoa(String.fromCharCode(...keyBuffer));

        await database.set(['system', 'jwtEncryptionKey'], keyString);

        return newKey;
    }
};

export const generateJWT = async (user: SubsonicUser, id: string): Promise<string> => {
    const payload = { user, id, exp: Math.floor(Date.now() / 1000) + 60 * 60 }; // 1 hour expiry
    const key = await generateOrGetKey();
    return await create({ alg: 'HS512', typ: 'JWT' }, payload, key);
};

export const verifyJWT = async (token: string) => {
    try {
        const key = await generateOrGetKey();
        return await verify(token, key);
    } catch {
        return null;
    }
};

export const authMiddleware: MiddlewareHandler = async (c, next) => {
    const pubPaths = ['/admin/login', '/api/login', '/api/version'];
    const publicApiPaths = [
        '/api/public-share-details',
        '/api/public-stream',
        '/api/public-cover',
    ];

    if (publicApiPaths.some((p) => c.req.path.startsWith(p))) {
        return await next();
    }

    const cookies = getCookies(c.req.raw.headers);
    const token = cookies.Dinosonic_Auth;

    if (!token) {
        if (pubPaths.includes(c.req.path)) return await next();
        return c.redirect('/admin/login');
    }

    const user = await verifyJWT(token);

    if (!user) {
        deleteCookie(c.res.headers, 'Dinosonic_Auth', { path: '/' });
        return c.redirect('/admin/login');
    }

    if (c.req.path === '/admin/login') return c.redirect('/admin/');

    c.set('user', user);
    await next();
};
