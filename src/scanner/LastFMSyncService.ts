import { checkInternetConnection, config, database, logger } from '../util.ts';
import { type Song, SongSchema, type User, userDataSchema, UserSchema } from '../zod.ts';
import { createTrackMapKey, getUserLovedTracksMap, getUsernameFromSessionKey, setTrackLoveStatus } from '../LastFM.ts';

interface SyncStats {
    pushedLove: number;
    pushedUnlove: number;
    pulledStars: number;
    updatedDates: number;
    skipped: number;
    errors: number;
}

async function syncUserLovedTracks(user: User, lastFMUsername: string) {
    if (!config.last_fm?.enable_scrobbling || !config.last_fm.api_key || !config.last_fm.api_secret || !user.backend.lastFMSessionKey) {
        return;
    }

    logger.info(`🔄 Syncing Last.fm loved tracks for ${lastFMUsername}`);

    if (!await checkInternetConnection()) {
        logger.warn(`No internet connection, skipping sync for ${lastFMUsername}`);
        return;
    }

    const remoteLovedMap = await getUserLovedTracksMap(lastFMUsername);
    if (!remoteLovedMap) {
        logger.error(`Failed to fetch loved tracks for ${lastFMUsername}`);
        return;
    }

    const stats: SyncStats = {
        pushedLove: 0,
        pushedUnlove: 0,
        pulledStars: 0,
        updatedDates: 0,
        skipped: 0,
        errors: 0,
    };

    const processedRemote = new Set<string>();

    for await (const entry of database.list({ prefix: ['userData', user.backend.id, 'track'] })) {
        const trackId = entry.key[3] as string;
        const udParse = userDataSchema.safeParse(entry.value);

        if (!udParse.success) {
            stats.errors++;
            continue;
        }

        const localUD = udParse.data;
        const trackEntry = await database.get(['tracks', trackId]);
        const songParse = SongSchema.safeParse(trackEntry.value);

        if (!songParse.success) {
            stats.errors++;
            continue;
        }

        const song = songParse.data;
        const remoteKey = createTrackMapKey(song.subsonic.artist, song.subsonic.title);
        const remoteTsUTS = remoteLovedMap.get(remoteKey);
        const isRemoteLove = !!remoteTsUTS;

        if (isRemoteLove) processedRemote.add(remoteKey);

        const localStar = localUD.starred ? new Date(localUD.starred) : null;
        const localUnstar = localUD.unstarred ? new Date(localUD.unstarred) : null;
        const isLocalStar = localStar && (!localUnstar || localStar.getTime() >= localUnstar.getTime());
        const remoteTsMs = isRemoteLove ? remoteTsUTS * 1000 : 0;

        try {
            if (isLocalStar && !isRemoteLove) {
                if (await setTrackLoveStatus(user, song.subsonic.artist, song.subsonic.title, true)) {
                    stats.pushedLove++;
                } else {
                    stats.errors++;
                }
            } else if (!isLocalStar && isRemoteLove) {
                if (localUnstar && localUnstar.getTime() > remoteTsMs) {
                    if (await setTrackLoveStatus(user, song.subsonic.artist, song.subsonic.title, false)) {
                        stats.pushedUnlove++;
                    } else {
                        stats.errors++;
                    }
                } else {
                    const updatedUD = { ...localUD, starred: new Date(remoteTsMs), unstarred: null };
                    if (userDataSchema.safeParse(updatedUD).success) {
                        await database.set(entry.key, updatedUD);
                        stats.pulledStars++;
                    } else {
                        stats.errors++;
                    }
                }
            } else if (isLocalStar && isRemoteLove && localStar) {
                if (remoteTsMs > localStar.getTime()) {
                    const updatedUD = { ...localUD, starred: new Date(remoteTsMs), unstarred: null };
                    if (userDataSchema.safeParse(updatedUD).success) {
                        await database.set(entry.key, updatedUD);
                        stats.updatedDates++;
                    } else {
                        stats.errors++;
                    }
                } else {
                    stats.skipped++;
                }
            } else {
                stats.skipped++;
            }
        } catch (error) {
            logger.error(`Error syncing track "${song.subsonic.title}": ${error}`);
            stats.errors++;
        }
    }

    for (const [remoteKey, remoteLoveTimestampUTS] of remoteLovedMap.entries()) {
        if (processedRemote.has(remoteKey)) continue;

        const [artistLower, titleLower] = remoteKey.split('||');
        let foundTrack: Song | null = null;

        for await (const trackEntry of database.list({ prefix: ['tracks'] })) {
            const songParse = SongSchema.safeParse(trackEntry.value);
            if (songParse.success) {
                const song = songParse.data;
                if (
                    song.subsonic.artist.toLowerCase() === artistLower &&
                    song.subsonic.title.toLowerCase() === titleLower
                ) {
                    foundTrack = song;
                    break;
                }
            }
        }

        if (foundTrack) {
            const trackId = foundTrack.subsonic.id;
            const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'track', trackId];
            const userDataEntry = await database.get(userDataKey);
            const localUD = userDataSchema.safeParse(userDataEntry.value).success ? userDataSchema.parse(userDataEntry.value) : { id: trackId };

            const localStar = localUD.starred ? new Date(localUD.starred) : null;
            const localUnstar = localUD.unstarred ? new Date(localUD.unstarred) : null;
            const isLocalStar = localStar && (!localUnstar || localStar.getTime() >= localUnstar.getTime());

            if (!isLocalStar) {
                const updatedUD = { ...localUD, starred: new Date(remoteLoveTimestampUTS * 1000), unstarred: null };
                const validationResult = userDataSchema.safeParse(updatedUD);

                if (validationResult.success) {
                    await database.set(userDataKey, validationResult.data);
                    stats.pulledStars++;
                } else {
                    stats.errors++;
                }
            } else {
                stats.skipped++;
            }
        } else {
            stats.skipped++;
        }
    }

    logger.info(
        `Sync complete for ${lastFMUsername}: ` +
            `❤️${stats.pushedLove} 💔${stats.pushedUnlove} ⭐${stats.pulledStars} ` +
            `📅${stats.updatedDates} ⏭️${stats.skipped} ❌${stats.errors}`,
    );
}

export async function syncAllUsersLovedTracks() {
    if (!config.last_fm?.enable_scrobbling) {
        return;
    }

    logger.info('Starting Last.fm sync for all users');
    let userCount = 0;

    for await (const entry of database.list({ prefix: ['users'] })) {
        const userParseResult = UserSchema.safeParse(entry.value);

        if (userParseResult.success) {
            const user = userParseResult.data;
            userCount++;

            if (user.backend?.lastFMSessionKey && config.last_fm.api_key && config.last_fm.api_secret) {
                const username = await getUsernameFromSessionKey(user.backend.lastFMSessionKey);
                if (username) {
                    await syncUserLovedTracks(user, username);
                }
            }
        }
    }

    if (userCount === 0) {
        logger.warn('No users found for Last.fm sync');
    }
}

export { syncUserLovedTracks as syncUserLovedTracksWithTimestamp };
