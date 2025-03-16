import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { User } from '../../zod.ts';

const deleteUser = new Hono();

async function handledeleteUser(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: "Only admins can get another users' info." });

    const username = await getField(c, 'username');
    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });

    const user = (await database.get(['users', username.toLowerCase()])).value as User | undefined;
    if (!user) return createResponse(c, {}, 'failed', { code: 70, message: 'User not found' });
    if (user.subsonic.username.toLowerCase() === isValidated.username.toLowerCase()) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'You cannot delete yourself.' });
    }

    await database.delete(['users', username.toLowerCase()]);

    return createResponse(c, {}, 'ok');
}

deleteUser.get('/deleteUser', handledeleteUser);
deleteUser.post('/deleteUser', handledeleteUser);
deleteUser.get('/deleteUser.view', handledeleteUser);
deleteUser.post('/deleteUser.view', handledeleteUser);

export default deleteUser;
