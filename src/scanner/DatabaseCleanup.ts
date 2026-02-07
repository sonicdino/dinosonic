import { database, logger } from '../util.ts';
import { AlbumSchema, ArtistSchema, PlaylistSchema, ShareSchema, type Song, SongSchema } from '../zod.ts';
import { updatePlaylistCover } from '../PlaylistManager.ts';

export async function cleanupDatabase(seenFiles: Set<string>) {
    logger.info('Starting database cleanup...');

    const seenTrackIds = new Set<string>();
    const albumsInUse = new Set<string>();
    const artistsInUse = new Set<string>();
    const coversInUse = new Set<string>();

    for await (const entry of database.list({ prefix: ['filePathToId'] })) {
        const filePath = entry.key[1] as string;
        const trackId = entry.value as string;

        if (!seenFiles.has(filePath)) {
            logger.info(`❌ Removing missing file track: ${trackId}`);
            await database.delete(['tracks', trackId]);
            await database.delete(entry.key);
        }
    }

    for await (const trackEntry of database.list({ prefix: ['tracks'] })) {
        const trackId = trackEntry.key[1] as string;
        const trackResult = SongSchema.safeParse(trackEntry.value);

        if (trackResult.success) {
            const track = trackResult.data;
            const filePathEntry = await database.get(['filePathToId', track.subsonic.path]);

            if (!filePathEntry.value) {
                logger.info(`⚠️ Track missing in filePathToId: ${trackId}. Deleting.`);
                await database.delete(['tracks', trackId]);
            } else {
                seenTrackIds.add(trackId);
                if (track.subsonic.albumId) albumsInUse.add(track.subsonic.albumId);
                if (track.subsonic.coverArt) coversInUse.add(track.subsonic.coverArt);
                for (const artist of track.subsonic.artists) {
                    artistsInUse.add(artist.id);
                }
            }
        } else {
            logger.warn(`Orphaned/malformed track data for ID ${trackId}, removing.`);
            await database.delete(['tracks', trackId]);
        }
    }

    for await (const albumEntry of database.list({ prefix: ['albums'] })) {
        const albumId = albumEntry.key[1] as string;

        if (!albumsInUse.has(albumId)) {
            logger.info(`❌ Removing orphaned album: ${albumId}`);
            await database.delete(['albums', albumId]);
            continue;
        }

        const albumResult = AlbumSchema.safeParse(albumEntry.value);
        if (albumResult.success) {
            const album = albumResult.data;

            if (album.subsonic.coverArt) coversInUse.add(album.subsonic.coverArt);
            for (const artist of album.subsonic.artists) {
                artistsInUse.add(artist.id);
            }

            const originalSongCount = album.subsonic.song.length;
            album.subsonic.song = album.subsonic.song.filter((songIdOrObj) => {
                const id = typeof songIdOrObj === 'string' ? songIdOrObj : (songIdOrObj as Song).subsonic?.id || (songIdOrObj as { id: string }).id;
                return seenTrackIds.has(id);
            });

            if (album.subsonic.song.length !== originalSongCount) {
                album.subsonic.songCount = album.subsonic.song.length;
                await database.set(albumEntry.key, album);
                logger.debug(`Updated album ${album.subsonic.name}, removed ${originalSongCount - album.subsonic.song.length} missing tracks`);
            }
        } else {
            logger.warn(`Malformed album data for ID ${albumId}, removing.`);
            await database.delete(['albums', albumId]);
        }
    }

    for await (const artistEntry of database.list({ prefix: ['artists'] })) {
        const artistId = artistEntry.key[1] as string;

        if (!artistsInUse.has(artistId)) {
            logger.info(`❌ Removing orphaned artist: ${artistId}`);
            await database.delete(['artists', artistId]);
            continue;
        }

        const artistResult = ArtistSchema.safeParse(artistEntry.value);
        if (artistResult.success) {
            if (artistResult.data.artist.coverArt) {
                coversInUse.add(artistResult.data.artist.coverArt);
            }
        } else {
            logger.warn(`Malformed artist data for ID ${artistId}, removing.`);
            await database.delete(['artists', artistId]);
        }
    }

    for await (const playlistEntry of database.list({ prefix: ['playlists'] })) {
        const playlistParseResult = PlaylistSchema.safeParse(playlistEntry.value);

        if (playlistParseResult.success) {
            const playlist = playlistParseResult.data;
            const originalLength = playlist.entry.length;

            playlist.entry = playlist.entry.filter((trackIdOrObject) => {
                const id = typeof trackIdOrObject === 'string' ? trackIdOrObject : (trackIdOrObject as { id: string }).id;
                return seenTrackIds.has(id);
            });

            if (playlist.entry.length !== originalLength) {
                playlist.songCount = playlist.entry.length;
                logger.info(`📝 Updated playlist "${playlist.name}", removed ${originalLength - playlist.entry.length} missing tracks`);
                await database.set(['playlists', playlist.id], playlist);
            }

            if (playlist.coverArt) coversInUse.add(playlist.id);
            if (await updatePlaylistCover(playlist.id)) coversInUse.add(playlist.id);
        } else {
            logger.warn(`Malformed playlist data for ID ${String(playlistEntry.key[1])}`);
        }
    }

    const orphanedCovers = new Set<string>();
    const sharesToDelete: Deno.KvKey[] = [];

    for await (const coverEntry of database.list({ prefix: ['covers'] })) {
        const coverId = coverEntry.key[1] as string;

        if (!coversInUse.has(coverId)) {
            orphanedCovers.add(coverId);
            await database.delete(coverEntry.key);
            logger.debug(`Removed orphaned cover: ${coverId}`);
        }
    }

    if (orphanedCovers.size > 0) {
        for await (const shareEntry of database.list({ prefix: ['shares'] })) {
            const shareResult = ShareSchema.safeParse(shareEntry.value);
            if (
                shareResult.success &&
                shareResult.data.itemType === 'coverArt' &&
                orphanedCovers.has(shareResult.data.itemId)
            ) {
                sharesToDelete.push(shareEntry.key);
            }
        }

        const BATCH_SIZE = 100;
        for (let i = 0; i < sharesToDelete.length; i += BATCH_SIZE) {
            const batch = sharesToDelete.slice(i, i + BATCH_SIZE);
            const txn = database.atomic();
            for (const key of batch) {
                txn.delete(key);
            }
            await txn.commit();
        }

        logger.info(`Deleted ${sharesToDelete.length} shares for orphaned covers`);
    }

    const userDataToDelete: Deno.KvKey[] = [];

    for await (const userDataEntry of database.list({ prefix: ['userData'] })) {
        const key = userDataEntry.key;

        if (key.length === 4) {
            const entityType = key[2] as string;
            const entityId = key[3] as string;

            if (
                (entityType === 'track' && !seenTrackIds.has(entityId)) ||
                (entityType === 'artist' && !artistsInUse.has(entityId)) ||
                (entityType === 'album' && !albumsInUse.has(entityId))
            ) {
                userDataToDelete.push(key);
            }
        }
    }

    if (userDataToDelete.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < userDataToDelete.length; i += BATCH_SIZE) {
            const batch = userDataToDelete.slice(i, i + BATCH_SIZE);
            const txn = database.atomic();
            for (const key of batch) {
                txn.delete(key);
            }
            await txn.commit();
        }

        logger.info(`Removed ${userDataToDelete.length} orphaned user data entries`);
    }

    seenTrackIds.clear();
    albumsInUse.clear();
    artistsInUse.clear();
    coversInUse.clear();

    logger.info('✅ Database cleanup complete');
}

export async function hardReset() {
    logger.warn('Hard resetting all track, album, and artist metadata!');

    const prefixesToClear: Deno.KvKeyPart[][] = [
        ['tracks'],
        ['albums'],
        ['artists'],
        ['covers'],
        ['filePathToId'],
        ['shares'],
        ['radioStations'],
    ];

    for (const prefix of prefixesToClear) {
        logger.info(`Clearing KV prefix: ${prefix.join('/')}`);
        const promises: Promise<void>[] = [];

        for await (const entry of database.list({ prefix })) {
            promises.push(database.delete(entry.key));

            if (promises.length >= 100) {
                await Promise.all(promises);
                promises.length = 0;
            }
        }

        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    logger.info('Hard reset complete');
}
