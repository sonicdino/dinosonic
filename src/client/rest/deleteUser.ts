import { Context, Hono } from '@hono/hono';
import { createResponse, deleteUserReferences, getField, getUserByUsername, validateAuth } from '../../util.ts';

const deleteUser = new Hono();

async function handleDeleteUser(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    if (!isValidated.adminRole) return createResponse(c, {}, 'failed', { code: 50, message: 'Only admins can delete users.' });

    const username = await getField(c, 'username');
    if (!username) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'username'" });

    const user = await getUserByUsername(username);
    if (!user) return createResponse(c, {}, 'failed', { code: 70, message: 'User not found' });
    if (user.subsonic.username.toLowerCase() === isValidated.username.toLowerCase()) {
        return createResponse(c, {}, 'failed', { code: 50, message: 'You cannot delete yourself.' });
    }

    // Delete the user and all related data
    await deleteUserReferences(user.backend.id);

    return createResponse(c, {}, 'ok');
}

deleteUser.get('/deleteUser', handleDeleteUser);
deleteUser.post('/deleteUser', handleDeleteUser);
deleteUser.get('/deleteUser.view', handleDeleteUser);
deleteUser.post('/deleteUser.view', handleDeleteUser);

export default deleteUser;
