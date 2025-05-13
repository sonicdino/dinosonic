import { Context, Hono } from '@hono/hono';
import { createResponse, validateAuth } from '../../util.ts';

const ping = new Hono();

async function handlePing(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    return createResponse(c, {}, 'ok');
}

ping.get('/ping', handlePing);
ping.post('/ping', handlePing);
ping.get('/ping.view', handlePing);
ping.post('/ping.view', handlePing);

export default ping;
