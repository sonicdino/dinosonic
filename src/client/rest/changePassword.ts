import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { User } from '../../zod.ts';

const changePassword = new Hono();

async function handlechangePassword(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const username = await getField(c, 'username');
    let password = await getField(c, 'password');

    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });
    if (username.toLowerCase() !== isValidated.username.toLowerCase() && !isValidated.adminRole) {
        return createResponse(c, {}, 'failed', { code: 50, message: "Only admins can change other users' password" });
    }

    if (!password) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'password'" });
    if (password.startsWith('enc:')) password = atob(password.slice(4));

    const user = (await database.get(['users', username.toLowerCase()])).value as User | undefined;
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: "User doesn't exist. Try creating the user instead." });

    user.backend.password = password;

    await database.set(['users', username.toLowerCase()], user);

    return createResponse(c, {}, 'ok');
}

changePassword.get('/changePassword', handlechangePassword);
changePassword.post('/changePassword', handlechangePassword);
changePassword.get('/changePassword.view', handlechangePassword);
changePassword.post('/changePassword.view', handlechangePassword);

export default changePassword;
