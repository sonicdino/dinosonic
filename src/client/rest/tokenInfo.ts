import { Context, Hono } from '@hono/hono';
import { createResponse, getField, getUserByApiKey } from '../../util.ts';

const tokenInfo = new Hono();

async function handleTokenInfo(c: Context) {
    const apiKey = await getField(c, 'apiKey');
    if (!apiKey) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'apiKey'" });
    const user = await getUserByApiKey(apiKey);
    if (!user) return createResponse(c, {}, 'failed', { code: 44, message: 'Invalid API key' });

    return createResponse(c, {
        tokenInfo: {
            username: user.subsonic.username,
        },
    }, 'ok');
}

tokenInfo.get('/tokenInfo', handleTokenInfo);
tokenInfo.post('/tokenInfo', handleTokenInfo);
tokenInfo.get('/tokenInfo.view', handleTokenInfo);
tokenInfo.post('/tokenInfo.view', handleTokenInfo);

export default tokenInfo;
