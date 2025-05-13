// star.ts
import { Context, Hono } from '@hono/hono';
// Added config, logger imports
import { config, createResponse, database, getFields, getUserByUsername, logger, validateAuth } from '../../util.ts';
import { AlbumSchema, ArtistSchema, SongSchema, userDataSchema } from '../../zod.ts';
// Added LastFM import
import { setTrackLoveStatus } from '../../LastFM.ts';

const star = new Hono();

async function handlestar(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;
    const ids = await getFields(c, 'id');
    const albumIds = await getFields(c, 'albumId');
    const artistIds = await getFields(c, 'artistId');

    if (!ids?.length && !albumIds?.length && !artistIds?.length) { // Check length to handle empty arrays
        return createResponse(c, {}, 'failed', { code: 10, message: 'Required id/albumId/artistId parameter is missing or empty' });
    }

    // Ensure user fetch occurs *before* the loop if needed multiple times
    const user = await getUserByUsername(isValidated.username); // Explicitly type user
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    // --- Handle Generic IDs (Could be Track, Album, or Artist) ---
    if (ids?.length) {
        for (const id of ids) {
            // Try Track first
            const trackEntry = await database.get(['tracks', id]);
            const track = SongSchema.safeParse(trackEntry.value).success ? SongSchema.parse(trackEntry.value) : null; // Validate track

            if (track) {
                const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'track', track.subsonic.id];
                const currentUserDataEntry = await database.get(userDataKey);
                const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                    ? userDataSchema.parse(currentUserDataEntry.value)
                    : undefined;

                const updatedUserData = userDataSchema.parse({
                    ...(currentUserData || { id: track.subsonic.id }), // Start with existing or default
                    starred: new Date(),
                    unstarred: null, // Explicitly clear unstarred
                });

                await database.set(userDataKey, updatedUserData);
                logger.debug(`Locally starred track ${id} for user ${user.backend.id}`);

                // --- Immediate Last.fm Sync ---
                if (config.last_fm?.enable_scrobbling && config.last_fm.api_key && config.last_fm.api_secret && user.backend.lastFMSessionKey) {
                    logger.info(`Attempting immediate Last.fm love for track ${id} (User: ${user.backend.id})`);
                    try {
                        const success = await setTrackLoveStatus(user, track.subsonic.artist, track.subsonic.title, true);
                        if (success) {
                            logger.info(`Immediate Last.fm love successful for track ${id}.`);
                        } else {
                            // Error already logged within setTrackLoveStatus
                            logger.warn(`Immediate Last.fm love potentially failed for track ${id} (check previous errors).`);
                        }
                        // deno-lint-ignore no-explicit-any
                    } catch (lfmError: any) {
                        logger.error(`Immediate Last.fm love CRASHED for track ${id}: ${lfmError.message}`);
                        // Do not re-throw, local update succeeded.
                    }
                } else {
                    logger.debug(`Skipping immediate Last.fm love for track ${id}: Sync disabled or user key/API secret missing.`);
                }
                // --- End Immediate Sync ---
                continue; // Move to next ID
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
                    starred: new Date(),
                    unstarred: null,
                });
                await database.set(userDataKey, updatedUserData);
                logger.debug(`Locally starred album ${id} for user ${user.backend.id}`);
                // NOTE: No immediate Last.fm sync for albums currently implemented
                continue; // Move to next ID
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
                    starred: new Date(),
                    unstarred: null,
                });
                await database.set(userDataKey, updatedUserData);
                logger.debug(`Locally starred artist ${id} for user ${user.backend.id}`);
                // NOTE: No immediate Last.fm sync for artists currently implemented
                continue; // Move to next ID
            }

            // If none matched
            logger.warn(`Star request failed: ID "${id}" not found as track, album, or artist.`);
            return createResponse(c, {}, 'failed', { code: 70, message: `Item with id ${id} not found` });
        }
    }

    // --- Handle Album IDs ---
    if (albumIds?.length) {
        for (const albumId of albumIds) {
            // No prefix check needed if ID comes directly
            const albumEntry = await database.get(['albums', albumId]);
            const album = AlbumSchema.safeParse(albumEntry.value).success ? AlbumSchema.parse(albumEntry.value) : null;
            if (!album) {
                logger.warn(`Star request failed: Album ID "${albumId}" not found.`);
                return createResponse(c, {}, 'failed', { code: 70, message: `Album with id ${albumId} not found` });
            }

            const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'album', album.subsonic.id];
            const currentUserDataEntry = await database.get(userDataKey);
            const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                ? userDataSchema.parse(currentUserDataEntry.value)
                : undefined;
            const updatedUserData = userDataSchema.parse({
                ...(currentUserData || { id: album.subsonic.id }),
                starred: new Date(),
                unstarred: null,
            });
            await database.set(userDataKey, updatedUserData);
            logger.debug(`Locally starred album ${albumId} for user ${user.backend.id}`);
            // NOTE: No immediate Last.fm sync for albums currently implemented
        }
    }

    // --- Handle Artist IDs ---
    if (artistIds?.length) {
        for (const artistId of artistIds) {
            const artistEntry = await database.get(['artists', artistId]);
            const artist = ArtistSchema.safeParse(artistEntry.value).success ? ArtistSchema.parse(artistEntry.value) : null;
            if (!artist) {
                logger.warn(`Star request failed: Artist ID "${artistId}" not found.`);
                return createResponse(c, {}, 'failed', { code: 70, message: `Artist with id ${artistId} not found` });
            }

            const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'artist', artist.artist.id];
            const currentUserDataEntry = await database.get(userDataKey);
            const currentUserData = userDataSchema.safeParse(currentUserDataEntry.value).success
                ? userDataSchema.parse(currentUserDataEntry.value)
                : undefined;
            const updatedUserData = userDataSchema.parse({
                ...(currentUserData || { id: artist.artist.id }),
                starred: new Date(),
                unstarred: null,
            });
            await database.set(userDataKey, updatedUserData);
            logger.debug(`Locally starred artist ${artistId} for user ${user.backend.id}`);
            // NOTE: No immediate Last.fm sync for artists currently implemented
        }
    }

    // If loop(s) completed without returning error
    return createResponse(c, {}, 'ok');
}

// Keep existing routes
star.get('/star', handlestar);
star.post('/star', handlestar);
star.get('/star.view', handlestar); // Subsonic compatibility
star.post('/star.view', handlestar); // Subsonic compatibility

export default star;
