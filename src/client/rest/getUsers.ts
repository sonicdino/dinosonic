import { Context, Hono } from '@hono/hono';
import { createResponse, database, validateAuth } from '../../util.ts';
import { User } from '../../zod.ts';

const getUsers = new Hono();

async function handlegetUsers(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: 'Only admins can access this endpoint.' });

    const users = (await Array.fromAsync(database.list({ prefix: ['users'] })))
        .map((entry) => (entry.value as User).subsonic);

    return createResponse(c, {
        users,
    }, 'ok');
}

getUsers.get('/getUsers', handlegetUsers);
getUsers.post('/getUsers', handlegetUsers);
getUsers.get('/getUsers.view', handlegetUsers);
getUsers.post('/getUsers.view', handlegetUsers);

export default getUsers;
