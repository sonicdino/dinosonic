import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getFields, getUserByUsername, validateAuth } from '../../util.ts';
import { PlayQueueSchema, Song } from '../../zod.ts';

const savePlayQueue = new Hono();

async function handlesavePlayQueue(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const ids = await getFields(c, 'id');
    const client = await getField(c, 'c');
    let current = await getField(c, 'current');
    let position = parseInt(await getField(c, 'position') || '0');
    if (isNaN(position)) position = 0;

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    if (!ids || !ids.length) {
        await database.delete(['playQueue', user.backend.id]);
        return createResponse(c, {}, 'ok');
    }

    const entry: string[] = [];

    for (const id of ids) {
        const song = (await database.get(['tracks', id])).value as Song | undefined;
        if (!song) continue;
        entry.push(id);
    }

    if (!entry.length) return createResponse(c, {}, 'ok');
    if (!current) current = entry[0];

    const currentIndex = entry.indexOf(current);

    const playQueue = PlayQueueSchema.safeParse({
        current,
        currentIndex: currentIndex >= 0 ? currentIndex : 0,
        position,
        entry,
        username: isValidated.username,
        changed: new Date(),
        changedBy: client,
    });

    if (!playQueue.success) return createResponse(c, {}, 'failed', { code: 10, message: 'A field is set wrong' });
    await database.set(['playQueue', user.backend.id], playQueue.data);

    return createResponse(c, {}, 'ok');
}

savePlayQueue.get('/savePlayQueue', handlesavePlayQueue);
savePlayQueue.post('/savePlayQueue', handlesavePlayQueue);
savePlayQueue.get('/savePlayQueue.view', handlesavePlayQueue);
savePlayQueue.post('/savePlayQueue.view', handlesavePlayQueue);

export default savePlayQueue;
