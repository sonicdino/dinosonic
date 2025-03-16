import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { User } from '../../zod.ts';

const getUser = new Hono();

async function handlegetUser(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: "Only admins can get another users' info." });

    const username = await getField(c, 'username') || '';
    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });

    const user = (await database.get(['users', username.toLowerCase()])).value as User | undefined;
    if (!user) return createResponse(c, {}, 'failed', { code: 70, message: 'User not found' });

    return createResponse(c, {
        user: user.subsonic,
    }, 'ok');
}

getUser.get('/getUser', handlegetUser);
getUser.post('/getUser', handlegetUser);
getUser.get('/getUser.view', handlegetUser);
getUser.post('/getUser.view', handlegetUser);

export default getUser;
