import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getFields, getUserByUsername, validateAuth } from '../../util.ts';
import { PlayQueueByIndexSchema, Song } from '../../zod.ts';

const savePlayQueueByIndex = new Hono();

async function handlesavePlayQueueByIndex(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const ids = await getFields(c, 'id');
    const client = await getField(c, 'c');
    const currentIndex = parseInt(await getField(c, 'currentIndex') || '0');
    let position = parseInt(await getField(c, 'position') || '0');
    if (isNaN(position)) position = 0;

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    if (!ids || !ids.length) {
        await database.delete(['playQueue', user.backend.id]);
        return createResponse(c, {}, 'ok');
    }

    const entry: string[] = [];

    if (ids && ids.length) {
        for (const id of ids) {
            const song = (await database.get(['tracks', id])).value as Song | undefined;
            if (!song) continue;
            entry.push(id);
        }
    }

    if (!entry.length) return createResponse(c, {}, 'ok');

    if (isNaN(currentIndex) || currentIndex < 0 || currentIndex >= entry.length) {
        return createResponse(c, {}, 'failed', { code: 10, message: 'currentIndex must be between 0 and length of queue - 1' });
    }

    const playQueue = PlayQueueByIndexSchema.safeParse({
        currentIndex,
        position,
        entry,
        username: isValidated.username,
        changed: new Date(),
        changedBy: client,
    });

    if (!playQueue.success) return createResponse(c, {}, 'failed', { code: 10, message: 'A field is set wrong' });
    await database.set(['playQueueByIndex', user.backend.id], playQueue.data);

    return createResponse(c, {}, 'ok');
}

savePlayQueueByIndex.get('/savePlayQueueByIndex', handlesavePlayQueueByIndex);
savePlayQueueByIndex.post('/savePlayQueueByIndex', handlesavePlayQueueByIndex);
savePlayQueueByIndex.get('/savePlayQueueByIndex.view', handlesavePlayQueueByIndex);
savePlayQueueByIndex.post('/savePlayQueueByIndex.view', handlesavePlayQueueByIndex);

export default savePlayQueueByIndex;
