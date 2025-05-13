// unstar.ts
import { Context, Hono } from '@hono/hono';
// Added config, logger imports
import { config, createResponse, database, getFields, getUserByUsername, logger, validateAuth } from '../../util.ts';
import { AlbumSchema, ArtistSchema, SongSchema, userDataSchema } from '../../zod.ts';
// Added LastFM import
import { setTrackLoveStatus } from '../../LastFM.ts';

const unstar = new Hono();

async function handleunstar(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const ids = await getFields(c, 'id');
    const albumIds = await getFields(c, 'albumId');
    const artistIds = await getFields(c, 'artistId');

    if (!ids?.length && !albumIds?.length && !artistIds?.length) { // Check length
        return createResponse(c, {}, 'failed', { code: 10, message: 'Required id/albumId/artistId parameter is missing or empty' });
    }

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    // --- Handle Generic IDs ---
    if (ids?.length) {
        for (const id of ids) {
            // Try Track
            const trackEntry = await database.get(['tracks', id]);
            const track = SongSchema.safeParse(trackEntry.value).success ? SongSchema.parse(trackEntry.value) : null;

            if (track) {
                const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'track', track.subsonic.id];
                const currentUserDataEntry = await database.get(userDataKey);
                const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                    ? userDataSchema.parse(currentUserDataEntry.value)
                    : undefined;

                const updatedUserData = userDataSchema.parse({
                    ...(currentUserData || { id: track.subsonic.id }),
                    starred: null, // Explicitly clear starred
                    unstarred: new Date(), // Set unstarred time
                });

                await database.set(userDataKey, updatedUserData);
                logger.debug(`Locally unstarred track ${id} for user ${user.backend.id}`);

                // --- Immediate Last.fm Sync ---
                if (config.last_fm?.enable_scrobbling && config.last_fm.api_key && config.last_fm.api_secret && user.backend.lastFMSessionKey) {
                    logger.info(`Attempting immediate Last.fm unlove for track ${id} (User: ${user.backend.id})`);
                    try {
                        // Call with loved = false for unstar
                        const success = await setTrackLoveStatus(user, track.subsonic.artist, track.subsonic.title, false);
                        if (success) {
                            logger.info(`Immediate Last.fm unlove successful for track ${id}.`);
                        } else {
                            logger.warn(`Immediate Last.fm unlove potentially failed for track ${id} (check previous errors).`);
                        }
                        // deno-lint-ignore no-explicit-any
                    } catch (lfmError: any) {
                        logger.error(`Immediate Last.fm unlove CRASHED for track ${id}: ${lfmError.message}`);
                    }
                } else {
                    logger.debug(`Skipping immediate Last.fm unlove for track ${id}: Sync disabled or user key/API secret missing.`);
                }
                // --- End Immediate Sync ---
                continue;
            }

            // Try Album
            const albumEntry = await database.get(['albums', id]);
            const album = AlbumSchema.safeParse(albumEntry.value).success ? AlbumSchema.parse(albumEntry.value) : null;
            if (album) {
                const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'album', album.subsonic.id];
                const currentUserDataEntry = await database.get(userDataKey);
                const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                    ? userDataSchema.parse(currentUserDataEntry.value)
                    : undefined;
                const updatedUserData = userDataSchema.parse({
                    ...(currentUserData || { id: album.subsonic.id }),
                    starred: null,
                    unstarred: new Date(),
                });
                await database.set(userDataKey, updatedUserData);
                logger.debug(`Locally unstarred album ${id} for user ${user.backend.id}`);
                continue;
            }

            // Try Artist
            const artistEntry = await database.get(['artists', id]);
            const artist = ArtistSchema.safeParse(artistEntry.value).success ? ArtistSchema.parse(artistEntry.value) : null;
            if (artist) {
                const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'artist', artist.artist.id];
                const currentUserDataEntry = await database.get(userDataKey);
                const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                    ? userDataSchema.parse(currentUserDataEntry.value)
                    : undefined;
                const updatedUserData = userDataSchema.parse({
                    ...(currentUserData || { id: artist.artist.id }),
                    starred: null,
                    unstarred: new Date(),
                });
                await database.set(userDataKey, updatedUserData);
                logger.debug(`Locally unstarred artist ${id} for user ${user.backend.id}`);
                continue;
            }

            logger.warn(`Unstar request failed: ID "${id}" not found as track, album, or artist.`);
            return createResponse(c, {}, 'failed', { code: 70, message: `Item with id ${id} not found` });
        }
    }

    // --- Handle Album IDs ---
    if (albumIds?.length) {
        for (const albumId of albumIds) {
            const albumEntry = await database.get(['albums', albumId]);
            const album = AlbumSchema.safeParse(albumEntry.value).success ? AlbumSchema.parse(albumEntry.value) : null;
            if (!album) {
                logger.warn(`Unstar request failed: Album ID "${albumId}" not found.`);
                return createResponse(c, {}, 'failed', { code: 70, message: `Album with id ${albumId} not found` });
            }

            const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'album', album.subsonic.id];
            const currentUserDataEntry = await database.get(userDataKey);
            const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                ? userDataSchema.parse(currentUserDataEntry.value)
                : undefined;
            const updatedUserData = userDataSchema.parse({
                ...(currentUserData || { id: album.subsonic.id }),
                starred: null,
                unstarred: new Date(),
            });
            await database.set(userDataKey, updatedUserData);
            logger.debug(`Locally unstarred album ${albumId} for user ${user.backend.id}`);
        }
    }

    // --- Handle Artist IDs ---
    if (artistIds?.length) {
        for (const artistId of artistIds) {
            const artistEntry = await database.get(['artists', artistId]);
            const artist = ArtistSchema.safeParse(artistEntry.value).success ? ArtistSchema.parse(artistEntry.value) : null;
            if (!artist) {
                logger.warn(`Unstar request failed: Artist ID "${artistId}" not found.`);
                return createResponse(c, {}, 'failed', { code: 70, message: `Artist with id ${artistId} not found` });
            }

            const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'artist', artist.artist.id];
            const currentUserDataEntry = await database.get(userDataKey);
            const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                ? userDataSchema.parse(currentUserDataEntry.value)
                : undefined;
            const updatedUserData = userDataSchema.parse({
                ...(currentUserData || { id: artist.artist.id }),
                starred: null,
                unstarred: new Date(),
            });
            await database.set(userDataKey, updatedUserData);
            logger.debug(`Locally unstarred artist ${artistId} for user ${user.backend.id}`);
        }
    }

    return createResponse(c, {}, 'ok');
}

// Keep existing routes
unstar.get('/unstar', handleunstar);
unstar.post('/unstar', handleunstar);
unstar.get('/unstar.view', handleunstar); // Subsonic compatibility
unstar.post('/unstar.view', handleunstar); // Subsonic compatibility

export default unstar;
