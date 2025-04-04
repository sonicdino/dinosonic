import { Context, Hono } from 'hono';
import { createResponse, database, encryptForTokenAuth, getField, getUserByUsername, validateAuth } from '../../util.ts';

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

    const user = await getUserByUsername(username);
    if (!user) return createResponse(c, {}, 'failed', { code: 40, message: "User doesn't exist. Try creating the user instead." });

    user.backend.password = await encryptForTokenAuth(password);

    await database.set(['users', user.backend.id], user);

    return createResponse(c, {}, 'ok');
}

changePassword.get('/changePassword', handlechangePassword);
changePassword.post('/changePassword', handlechangePassword);
changePassword.get('/changePassword.view', handlechangePassword);
changePassword.post('/changePassword.view', handlechangePassword);

export default changePassword;
