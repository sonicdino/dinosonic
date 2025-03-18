import { Context, Hono } from 'hono';
import { createResponse, database, getFields, validateAuth } from '../../util.ts';
import { Album, Artist, Song, userData, userDataSchema } from '../../zod.ts';

const star = new Hono();

async function handlestar(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const ids = await getFields(c, 'id');
    const albumIds = await getFields(c, 'albumId');
    const artistIds = await getFields(c, 'artistId');

    if (!ids && !albumIds && !artistIds) return createResponse(c, {}, 'failed', { code: 10, message: 'Required id parameter is missing' });

    if (ids?.length) {
        for (const id of ids) {
            if (id.startsWith('t')) {
                const track = (await database.get(['tracks', id])).value as Song | null;
                if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });

                let userData = (await database.get(['userData', isValidated.username, 'track', track.subsonic.id])).value as userData | undefined;
                if (!userData) {
                    userData = userDataSchema.parse({
                        id: track.subsonic.id,
                        starred: new Date(),
                    });
                } else userData.starred = new Date();
                await database.set(['userData', isValidated.username, 'track', track.subsonic.id], userData);
            } else if (id.startsWith('a')) {
                const album = (await database.get(['albums', id])).value as Album | null;
                if (!album) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

                let userData = (await database.get(['userData', isValidated.username, 'album', album.subsonic.id])).value as userData | undefined;
                if (!userData) {
                    userData = userDataSchema.parse({
                        id: album.subsonic.id,
                        starred: new Date(),
                    });
                } else userData.starred = new Date();
                await database.set(['userData', isValidated.username, 'album', album.subsonic.id], userData);
            } else if (id.startsWith('A')) {
                const artist = (await database.get(['artists', id])).value as Artist | null;
                if (!artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

                let userData = (await database.get(['userData', isValidated.username, 'artist', artist.artist.id])).value as userData | undefined;
                if (!userData) {
                    userData = userDataSchema.parse({
                        id: artist.artist.id,
                        starred: new Date(),
                    });
                } else userData.starred = new Date();
                await database.set(['userData', isValidated.username, 'artist', artist.artist.id], userData);
            } else return createResponse(c, {}, 'failed', { code: 70, message: 'Invalid id provided' });
        }
    }

    if (albumIds?.length) {
        for (const albumId of albumIds) {
            if (!albumId.startsWith('a')) return createResponse(c, {}, 'failed', { code: 70, message: 'Invalid id provided' });
            const album = (await database.get(['albums', albumId])).value as Album | null;
            if (!album) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

            let userData = (await database.get(['userData', isValidated.username, 'album', album.subsonic.id])).value as userData | undefined;
            if (!userData) {
                userData = userDataSchema.parse({
                    id: album.subsonic.id,
                    starred: new Date(),
                });
            } else userData.starred = new Date();
            await database.set(['userData', isValidated.username, 'album', album.subsonic.id], userData);
        }
    }

    if (artistIds?.length) {
        for (const artistId of artistIds) {
            if (!artistId.startsWith('A')) return createResponse(c, {}, 'failed', { code: 70, message: 'Invalid id provided' });
            const artist = (await database.get(['artists', artistId])).value as Artist | null;
            if (!artist) return createResponse(c, {}, 'failed', { code: 70, message: 'Album not found' });

            let userData = (await database.get(['userData', isValidated.username, 'artist', artist.artist.id])).value as userData | undefined;
            if (!userData) {
                userData = userDataSchema.parse({
                    id: artist.artist.id,
                    starred: new Date(),
                });
            } else userData.starred = new Date();
            await database.set(['userData', isValidated.username, 'artist', artist.artist.id], userData);
        }
    }

    // TODO: Sync with LastFM. T his is only possible after UI is done.

    return createResponse(c, {}, 'ok');
}

star.get('/star', handlestar);
star.post('/star', handlestar);
star.get('/star.view', handlestar);
star.post('/star.view', handlestar);

export default star;
