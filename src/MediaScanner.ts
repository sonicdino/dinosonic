// MediaScanner.ts
// Here houses the recursive file scanner and metadata scanner.
import { walk } from '@std/fs';
import { IAudioMetadata, IPicture, parseFile } from 'music-metadata';
import * as path from '@std/path';
import { checkInternetConnection, config, database, generateId, getUserByUsername, logger, separatorsToRegex } from './util.ts';
import {
    AlbumID3Artists,
    AlbumInfoSchema,
    AlbumReleaseDateSchema,
    AlbumSchema,
    Artist,
    ArtistID3Schema,
    ArtistInfoSchema,
    ArtistSchema,
    CoverArtSchema,
    PlaylistSchema,
    ReplayGainSchema,
    ShareSchema, // Added
    Song,
    SongSchema,
    StructuredLyrics,
    StructuredLyricsSchema,
    User,
    userDataSchema,
    UserSchema,
} from './zod.ts';
import { Genre } from './zod.ts';
import { createTrackMapKey, getAlbumInfo, getArtistInfo, getUserLovedTracksMap, getUsernameFromSessionKey, setTrackLoveStatus } from './LastFM.ts';
import { getArtistCover } from './Spotify.ts';
import { exists } from '@std/fs/exists';

const seenFiles = new Set<string>();

interface ScanStatus {
    scanning: boolean;
    count: number;
    totalFiles: number;
    lastScan: Date;
}

let scanStatus: ScanStatus = {
    scanning: false,
    count: 0,
    totalFiles: 0,
    lastScan: new Date(),
};

// Helper function to create a share for a cover art item
async function createOrGetCoverArtShare(
    coverArtId: string, // This is the ID of the CoverArt entry (e.g., albumId or artistId)
    userIdForShare: string,
    description: string,
): Promise<string | null> {
    // More robust check for existing shares: by itemId, itemType, and description
    for await (const entry of database.list({ prefix: ['shares'] })) {
        const existingShareResult = ShareSchema.safeParse(entry.value);
        if (
            existingShareResult.success &&
            existingShareResult.data.itemType === 'coverArt' &&
            existingShareResult.data.itemId === coverArtId &&
            existingShareResult.data.description === description &&
            existingShareResult.data.userId === userIdForShare // Also check creator for system shares
        ) {
            logger.debug(`Found existing internal coverArt share ${existingShareResult.data.id} for cover ${coverArtId} (${description})`);
            return existingShareResult.data.id;
        }
    }

    const shareId = await generateId();
    const newShareData = {
        id: shareId,
        userId: userIdForShare,
        itemId: coverArtId,
        itemType: 'coverArt',
        description: description,
        created: new Date(),
        expires: null, // System shares for covers typically don't expire
        viewCount: 0,
    };
    const newShare = ShareSchema.safeParse(newShareData);

    if (newShare.success) {
        await database.set(['shares', shareId], newShare.data);
        logger.debug(`Created internal coverArt share ${shareId} for cover ${coverArtId} (${description})`);
        return shareId;
    } else {
        logger.error(`Failed to validate new internal coverArt share for ${coverArtId}: ${JSON.stringify(newShare.error.issues)}`);
        return null;
    }
}

export async function hardReset() {
    logger.warn('Hard resetting all track, album, and artist metadata!');
    const kv = database; // Use the global database instance

    const prefixesToClear: Deno.KvKeyPart[][] = [
        ['tracks'],
        ['albums'],
        ['artists'],
        ['covers'],
        ['filePathToId'],
        ['shares'], // Added shares
    ];

    for (const prefix of prefixesToClear) {
        logger.info(`Clearing KV prefix: ${prefix.join('/')}`);
        const iter = kv.list({ prefix });
        const promises = [];
        for await (const entry of iter) {
            promises.push(kv.delete(entry.key));
        }
        await Promise.all(promises);
    }
    // Note: cleanupDatabase might not be necessary after a full prefix clear,
    // but it's good for general consistency if some data remains.
    // For a true hard reset, the prefix clear is more thorough.
    await cleanupDatabase();

    logger.info('Hard reset done. starting scan now..');
    await scanMediaDirectories(config.music_folders);
}

export async function scanMediaDirectories(directories: string[], cleanup: boolean = true, debug_log: boolean = false) {
    if (scanStatus.scanning) {
        logger.warn('Scan already in progress.');
        return scanStatus;
    }

    scanStatus = { scanning: true, count: 0, totalFiles: 0, lastScan: new Date() };

    for (const dir of directories) {
        logger[debug_log ? 'debug' : 'info'](`🔍 Scanning directory: ${dir}`);
        await scanDirectory(dir);
    }

    if (cleanup) await cleanupDatabase();
    await handleLastFMMetadata(); // This will now create coverArt shares
    await syncAllConfiguredUsersFavoritesToLastFM();
    seenFiles.clear();
    scanStatus.scanning = false;
    logger[debug_log ? 'debug' : 'info']('✅ Media scan complete.');
    return scanStatus;
}

async function cleanupDatabase() {
    // Consider if orphaned 'coverArt' shares need specific cleanup if their 'itemId' (album/artist) is gone.
    // For now, the existing cleanup should remove albums/artists, and then getShares filters coverArt.
    // If a cover entry itself is orphaned, its shares would point to nothing.
    const seenTrackIds = new Set<string>();
    const albumsInUse = new Set<string>();
    const artistsInUse = new Set<string>();
    const coversInUse = new Set<string>(); // To track used cover IDs

    // Pass 1: Process tracks, populate albumsInUse, artistsInUse, coversInUse
    for await (const entry of database.list({ prefix: ['filePathToId'] })) {
        const filePath = entry.key[1] as string;
        const trackId = entry.value as string;

        if (!seenFiles.has(filePath)) {
            logger.info(`❌ Removing missing file track: ${trackId}`);
            await database.delete(['tracks', trackId]);
            await database.delete(entry.key); // Remove from filePathToId
        }
    }
    for await (const trackEntry of database.list({ prefix: ['tracks'] })) {
        const trackId = trackEntry.key[1] as string;
        const trackResult = SongSchema.safeParse(trackEntry.value);

        if (trackResult.success) {
            const track = trackResult.data;
            const filePathEntry = await database.get(['filePathToId', track.subsonic.path]);
            if (!filePathEntry.value) { // Check if file path still mapped
                logger.info(`⚠️ Track missing in filePathToId: ${trackId}, path: ${track.subsonic.path}. Deleting track.`);
                await database.delete(['tracks', trackId]);
                continue;
            }
            seenTrackIds.add(trackId);
            if (track.subsonic.albumId) albumsInUse.add(track.subsonic.albumId);
            if (track.subsonic.coverArt) coversInUse.add(track.subsonic.coverArt); // Track might use album cover
            for (const artist of track.subsonic.artists) {
                artistsInUse.add(artist.id);
            }
        } else {
            logger.warn(`Orphaned/malformed track data for ID ${trackId}, removing.`);
            await database.delete(['tracks', trackId]);
        }
    }

    // Pass 2: Process albums, populate coversInUse, update song lists
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
            for (const artist of album.subsonic.artists) artistsInUse.add(artist.id);

            const originalSongCount = album.subsonic.song.length;
            album.subsonic.song = album.subsonic.song.filter((songIdOrObj) => {
                // deno-lint-ignore no-explicit-any
                const id = typeof songIdOrObj === 'string' ? songIdOrObj : (songIdOrObj as any).id;
                return seenTrackIds.has(id);
            });
            if (album.subsonic.song.length !== originalSongCount) {
                album.subsonic.songCount = album.subsonic.song.length;
                // Recalculate duration if needed, or assume it's correct from initial scan
                await database.set(albumEntry.key, album);
            }
        } else {
            logger.warn(`Malformed album data for ID ${albumId}, removing.`);
            await database.delete(['albums', albumId]);
        }
    }

    // Pass 3: Process artists, populate coversInUse
    for await (const artistEntry of database.list({ prefix: ['artists'] })) {
        const artistId = artistEntry.key[1] as string;
        if (!artistsInUse.has(artistId)) {
            logger.info(`❌ Removing orphaned artist: ${artistId}`);
            await database.delete(['artists', artistId]);
            continue;
        }
        const artistResult = ArtistSchema.safeParse(artistEntry.value);
        if (artistResult.success) {
            if (artistResult.data.artist.coverArt) coversInUse.add(artistResult.data.artist.coverArt);
        } else {
            logger.warn(`Malformed artist data for ID ${artistId}, removing.`);
            await database.delete(['artists', artistId]);
        }
    }

    // Pass 4: Cleanup orphaned CoverArt entries and their Shares
    for await (const coverEntry of database.list({ prefix: ['covers'] })) {
        const coverId = coverEntry.key[1] as string;
        if (!coversInUse.has(coverId)) {
            logger.info(`❌ Removing orphaned cover: ${coverId} and its shares.`);
            await database.delete(coverEntry.key);
            // Also delete shares pointing to this coverId
            for await (const shareEntry of database.list({ prefix: ['shares'] })) {
                const share = ShareSchema.safeParse(shareEntry.value).data;
                if (share && share.itemType === 'coverArt' && share.itemId === coverId) {
                    await database.delete(shareEntry.key);
                    logger.debug(`Deleted share ${share.id} for orphaned cover ${coverId}`);
                }
            }
        }
    }

    // Pass 5: Cleanup UserData and Playlists (as before)
    // ... (rest of cleanupDatabase as provided previously for userData and playlists) ...
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
                logger.info(`❌ Removing user data for missing ${entityType}: ${entityId}`);
                await database.delete(userDataEntry.key);
            }
        }
    }
    for await (const playlistEntry of database.list({ prefix: ['playlists'] })) {
        const playlistParseResult = PlaylistSchema.safeParse(playlistEntry.value);
        if (playlistParseResult.success) {
            const playlist = playlistParseResult.data;
            const originalLength = playlist.entry.length;
            playlist.entry = playlist.entry.filter((trackIdOrObject) => {
                // deno-lint-ignore no-explicit-any
                const id = typeof trackIdOrObject === 'string' ? trackIdOrObject : (trackIdOrObject as any).id;
                return seenTrackIds.has(id);
            });
            if (playlist.entry.length !== originalLength) {
                playlist.songCount = playlist.entry.length;
                // Recalculate duration if needed
                logger.info(`📝 Updated playlist "${playlist.name}", removed missing tracks.`);
                await database.set(['playlists', playlist.id], playlist);
            }
        } else {
            logger.warn(`Data for playlist ID ${String(playlistEntry.key[1])} did not match PlaylistSchema.`);
        }
    }

    seenTrackIds.clear();
    albumsInUse.clear();
    artistsInUse.clear();
    coversInUse.clear();
}

async function scanDirectory(dir: string) {
    // ... (scanDirectory logic remains the same)
    for await (const _entry of walk(dir, { exts: ['.flac', '.mp3', '.wav', '.ogg', '.m4a'] })) {
        scanStatus.totalFiles++;
    }
    const processExts = ['.flac', '.mp3', '.wav', '.ogg', '.m4a'];
    for await (const entry of walk(dir, { match: [new RegExp(`\\.(${processExts.map((ext) => ext.substring(1)).join('|')})$`, 'i')] })) {
        if (entry.isFile) {
            const filePath = entry.path;
            seenFiles.add(filePath);
            await processMediaFile(entry.path);
            scanStatus.count++;
        }
    }
}

async function processMediaFile(filePath: string) {
    // ... (processMediaFile logic remains the same)
    let trackId = (await database.get(['filePathToId', filePath])).value as string | null;
    if (!trackId) {
        trackId = await generateId();
        await database.set(['filePathToId', filePath], trackId);
    }
    const metadata = await extractMetadata(filePath, trackId);
    if (!metadata) return;
    logger.info(`📀 Updating metadata for ${filePath}`);
    await database.set(['tracks', trackId], metadata);
}

export async function getArtistIDByName(name: string): Promise<string | undefined> {
    // ... (remains the same)
    for await (const entry of database.list({ prefix: ['artists'] })) {
        const artistParseResult = ArtistSchema.safeParse(entry.value);
        if (artistParseResult.success) {
            const artistData = artistParseResult.data;
            if (artistData.artist.name.toLowerCase().trim() === name.toLowerCase().trim()) {
                return artistData.artist.id;
            }
        }
    }
    return undefined;
}

async function getAlbumIDByName(name: string, artists?: AlbumID3Artists[]): Promise<string | undefined> {
    // ... (remains the same)
    const albums = database.list({ prefix: ['albums'] });
    for await (const { value } of albums) {
        const parsedEntry = AlbumSchema.safeParse(value);
        if (!parsedEntry.success) continue;
        const { subsonic } = parsedEntry.data;
        if (subsonic.name.toLowerCase().trim() !== name.toLowerCase().trim()) continue;
        if (
            !artists?.length ||
            subsonic.artists.some((albumArtist) => artists.some((a) => a.name.toLowerCase().trim() === albumArtist.name.toLowerCase().trim()))
        ) {
            return subsonic.id;
        }
    }
    return undefined;
}

// MODIFIED storePrimaryCoverArt:
// - Prioritizes existing cover in DB if not explicitly told to overwrite (e.g., initial scan).
// - When called from LastFM/Spotify, it will only overwrite if no cover exists,
//   or if we decide specific sources (e.g. Spotify) can overwrite.
async function storePrimaryCoverArt(
    itemId: string,
    externalUrl?: string, // URL from LastFM/Spotify (optional)
    pictures?: IPicture[], // Embedded pictures from track metadata (optional)
    trackPath?: string, // Path of a track (to look for folder.jpg, etc.) (optional)
): Promise<string | null> {
    const coversDir = path.join(config.data_folder, 'covers');
    await Deno.mkdir(coversDir, { recursive: true }).catch(() => {});

    const mimeToExt: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
    };

    // 1. Check if a high-quality cover already exists in the database and on disk
    const existingCoverEntry = await database.get(['covers', itemId]);
    if (existingCoverEntry.value) {
        const parsedExisting = CoverArtSchema.safeParse(existingCoverEntry.value);
        if (parsedExisting.success && await exists(parsedExisting.data.path)) {
            logger.debug(`Primary cover for ${itemId} already exists at ${parsedExisting.data.path}. Using existing.`);
            return parsedExisting.data.path; // Use existing, don't try to find/download another
        } else {
            // DB entry exists but file is missing - treat as no cover exists, proceed to find/download
            logger.warn(`Cover for ${itemId} in DB but file missing at ${parsedExisting.data?.path || 'unknown path'}. Attempting to re-acquire.`);
        }
    }

    let coverData: { data: Uint8Array; format: string } | null = null;
    let newCoverSource = '';

    // 2. Try embedded pictures first (highest priority for new covers)
    if (pictures && pictures.length > 0) {
        const pic = pictures.find((p) => p.type?.toLowerCase().includes('cover (front)')) ||
            pictures.find((p) => p.type?.toLowerCase().startsWith('cover')) ||
            pictures[0];
        if (pic) {
            coverData = { data: pic.data, format: pic.format };
            newCoverSource = 'embedded image';
        }
    }

    // 3. Try local file (folder.jpg, etc.) if no embedded found
    if (!coverData && trackPath) {
        const dir = path.dirname(trackPath);
        const coverNames = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.png', 'album.jpg', 'front.jpg', 'front.png'];
        for (const name of coverNames) {
            const localCoverPath = path.join(dir, name);
            if (await exists(localCoverPath)) {
                try {
                    const fileData = await Deno.readFile(localCoverPath);
                    const ext = path.extname(localCoverPath).substring(1).toLowerCase();
                    coverData = { data: fileData, format: `image/${ext || 'jpeg'}` };
                    newCoverSource = `local file (${name})`;
                    break;
                } catch (e) {
                    logger.error(`Error reading local cover ${localCoverPath}: ${e}`);
                }
            }
        }
    }

    // 4. Try external URL (e.g., Last.fm/Spotify) only if no embedded or local file was found
    if (!coverData && externalUrl) {
        try {
            logger.debug(`Attempting to download cover for ${itemId} from ${externalUrl} as no local/embedded found.`);
            const response = await fetch(externalUrl, { headers: { 'Accept': 'image/*' } });
            if (response.ok && response.body) {
                const contentType = response.headers.get('content-type')?.split(';')[0].trim() || '';
                if (contentType.startsWith('image/')) {
                    coverData = { data: new Uint8Array(await response.arrayBuffer()), format: contentType };
                    newCoverSource = externalUrl.includes('spotify')
                        ? 'Spotify'
                        : externalUrl.includes('last.fm') || externalUrl.includes('audioscrobbler')
                        ? 'Last.fm'
                        : 'external URL';
                } else {
                    logger.warn(`Skipping download for ${itemId} from ${externalUrl}: Content-Type not an image (${contentType})`);
                }
            } else {
                logger.warn(`Failed to download cover for ${itemId} from ${externalUrl}: ${response.status}`);
            }
            // deno-lint-ignore no-explicit-any
        } catch (e: any) {
            logger.error(`Error downloading ${externalUrl} for ${itemId}: ${e.message}`);
        }
    }

    // If any cover data was obtained (and none existed in DB initially, or DB entry was invalid)
    if (coverData) {
        const ext = mimeToExt[coverData.format.toLowerCase()] || 'jpg';
        const finalPath = path.join(coversDir, `${itemId}.${ext}`);
        try {
            await Deno.writeFile(finalPath, coverData.data);
            const newCoverArtEntry = CoverArtSchema.safeParse({
                id: itemId,
                mimeType: coverData.format,
                path: finalPath,
            });
            if (newCoverArtEntry.success) {
                await database.set(['covers', itemId], newCoverArtEntry.data);
                logger.info(`Stored primary cover for ${itemId} (from ${newCoverSource || 'unknown'}) at ${finalPath}`);
                return finalPath;
            } else {
                logger.error(`Failed to validate CoverArt entry for ${itemId}: ${JSON.stringify(newCoverArtEntry.error.issues)}`);
            }
        } catch (e) {
            logger.error(`Error writing cover file ${finalPath} for ${itemId}: ${e}`);
        }
    }
    // If we reached here, no new cover was set, and no valid existing one was found initially.
    logger.warn(`No cover art ultimately processed or stored for ${itemId}.`);
    return null;
}
async function handleAlbum(albumId: string, trackId: string, albumArtists: AlbumID3Artists[], metadata: IAudioMetadata) {
    // ... (handleAlbum logic remains mostly the same, but ensures subsonic.coverArt is set to albumId)
    // Key part is that album.subsonic.coverArt will be albumId, which storePrimaryCoverArt will use.
    const albumEntry = await database.get(['albums', albumId]);
    const existingAlbumParse = AlbumSchema.safeParse(albumEntry.value);
    const existingAlbum = existingAlbumParse.success ? existingAlbumParse.data : null;

    if (existingAlbum) {
        // ... (update logic as before)
        let changes = false;
        const songSet = new Set(
            existingAlbum.subsonic.song.map((s) => typeof s === 'string' ? s : (s as Song).subsonic.id || (s as { id: string }).id).filter(Boolean),
        );
        if (!songSet.has(trackId)) {
            existingAlbum.subsonic.song.push(trackId);
            existingAlbum.subsonic.songCount = existingAlbum.subsonic.song.length;
            existingAlbum.subsonic.duration = Math.round(existingAlbum.subsonic.duration + (metadata.format.duration || 0));
            changes = true;
        }
        // ... (other update logic) ...
        if (changes) {
            existingAlbum.subsonic.displayArtist = existingAlbum.subsonic.artists.length > 1
                ? existingAlbum.subsonic.artists.slice(0, -1).map((a) => a.name).join(', ') + ' & ' +
                    existingAlbum.subsonic.artists[existingAlbum.subsonic.artists.length - 1].name
                : existingAlbum.subsonic.artists[0]?.name || '';
            const validatedAlbum = AlbumSchema.safeParse(existingAlbum);
            if (validatedAlbum.success) await database.set(['albums', albumId], validatedAlbum.data);
            else logger.error(`Error re-validating existing album ${albumId}: ${validatedAlbum.error.issues}`);
        }
        return;
    }
    // ... (create new album logic, ensuring subsonic.coverArt = albumId)
    const [yearStr, monthStr, dayStr] = (metadata.common.date || metadata.common.originalyear?.toString() || '1970-1-1').split('-');
    const releaseDate = AlbumReleaseDateSchema.safeParse({ year: parseInt(yearStr), month: parseInt(monthStr), day: parseInt(dayStr) });
    const genres: Genre[] | undefined =
        metadata.common.genre?.flatMap((g) => g.split(separatorsToRegex(config.genre_separators)).map((name) => ({ name: name.trim() }))).filter(
            (g) => g.name,
        ) || undefined;

    const newAlbumData = {
        backend: { dateAdded: Date.now(), lastFM: false },
        subsonic: {
            id: albumId,
            name: metadata.common.album || 'Unknown Album',
            artist: albumArtists[0]?.name || 'Unknown Artist',
            year: metadata.common.year || (releaseDate.success ? releaseDate.data.year : undefined),
            coverArt: albumId, // CRUCIAL: Points to its own ID for cover lookup
            duration: metadata.format.duration ? Math.round(metadata.format.duration) : 0,
            genre: genres?.map((g) => g.name).join(', ') || undefined,
            genres: genres,
            created: new Date(
                metadata.common.date ||
                    (releaseDate.success ? `${releaseDate.data.year}-${releaseDate.data.month}-${releaseDate.data.day}` : '1970-01-01'),
            ).toISOString(),
            artistId: albumArtists[0]?.id || undefined,
            songCount: 1,
            artists: albumArtists,
            displayArtist: albumArtists.length > 1
                ? albumArtists.slice(0, -1).map((a) => a.name).join(', ') + ' & ' + albumArtists[albumArtists.length - 1].name
                : albumArtists[0]?.name || '',
            releaseTypes: metadata.common.releasetype ? [metadata.common.releasetype.join('/')] : ['album'],
            originalReleaseDate: releaseDate.success ? releaseDate.data : undefined,
            releaseDate: releaseDate.success ? releaseDate.data : undefined,
            song: [trackId],
            discTitles: [{ disc: metadata.common.disk.no || 1, title: `Disc ${metadata.common.disk.no || 1}` }],
            musicBrainzId: metadata.common.musicbrainz_albumid || undefined,
        },
    };
    const albumParseResult = AlbumSchema.safeParse(newAlbumData);
    if (albumParseResult.success) {
        await database.set(['albums', albumId], albumParseResult.data);
        for (const anArtist of albumArtists) {
            const artistEntry = await database.get(['artists', anArtist.id]);
            const artistParse = ArtistSchema.safeParse(artistEntry.value);
            if (artistParse.success) {
                const artist = artistParse.data;
                if (!artist.artist.album.includes(albumId)) {
                    artist.artist.album.push(albumId);
                    artist.artist.albumCount = artist.artist.album.length;
                    await database.set(['artists', artist.artist.id], artist);
                }
            }
        }
    } else {
        logger.error(`Failed to validate new album ${albumId}: ${albumParseResult.error.issues}`);
    }
}

async function handleArtist(artistString: string): Promise<AlbumID3Artists[]> {
    // ... (handleArtist logic remains the same, ensuring artist.artist.coverArt = artist.id)
    const unsortedNames = artistString.split(separatorsToRegex(config.artist_separators));
    const sortedArtists: AlbumID3Artists[] = [];
    for (const name of unsortedNames) {
        const trimmedName = name.trim();
        if (!trimmedName) continue;
        let id = await getArtistIDByName(trimmedName);
        let artistData: Artist | null = null;
        if (id) {
            const artistEntry = await database.get(['artists', id]);
            const parseResult = ArtistSchema.safeParse(artistEntry.value);
            if (parseResult.success) artistData = parseResult.data;
        }
        if (!artistData) {
            id = await generateId();
            const newArtistArtistPart = ArtistID3Schema.safeParse({
                id,
                name: trimmedName,
                coverArt: id, // CRUCIAL: Artist cover points to artist's own ID
                albumCount: 0,
                album: [],
            });
            if (newArtistArtistPart.success) {
                const newArtistFull = ArtistSchema.safeParse({ artist: newArtistArtistPart.data, lastFM: false });
                if (newArtistFull.success) {
                    await database.set(['artists', id], newArtistFull.data);
                    artistData = newArtistFull.data;
                } else {
                    logger.error(`Failed to validate new full artist ${trimmedName}: ${newArtistFull.error.issues}`);
                }
            } else {
                logger.error(`Failed to validate new artist part ${trimmedName}: ${newArtistArtistPart.error.issues}`);
            }
        }
        if (artistData) {
            sortedArtists.push({ id: artistData.artist.id, name: artistData.artist.name });
        }
    }
    return sortedArtists;
}

// MODIFIED handleLastFMMetadata
async function handleLastFMMetadata() {
    const connectedToInternet = await checkInternetConnection();
    const adminUser = await getUserByUsername('admin');
    const systemUserIdForShares = adminUser ? adminUser.backend.id : 'dinosonic_system_user_id';

    if (connectedToInternet && config.last_fm?.enabled && config.last_fm.api_key) {
        logger.info('Starting Last.fm metadata fetch and cover share creation...');
        // ALBUMS
        for await (const albumEntry of database.list({ prefix: ['albums'] })) {
            const albumParseResult = AlbumSchema.safeParse(albumEntry.value);
            if (!albumParseResult.success) continue;
            const album = albumParseResult.data;

            if (album.backend.lastFM && album.albumInfo?.smallImageUrl?.startsWith('/api/public-cover')) {
                continue;
            }

            const primaryArtistName = album.subsonic.artists[0]?.name || album.subsonic.artist;
            if (!primaryArtistName) continue;

            const lfmAlbumInfo = await getAlbumInfo(album.subsonic.name, primaryArtistName);
            if (lfmAlbumInfo && lfmAlbumInfo.album) {
                const lfmData = lfmAlbumInfo.album;
                const coverArtIdForAlbum = album.subsonic.id;

                // deno-lint-ignore no-explicit-any
                const largeLfmUrl = lfmData.image?.find((i: any) => i.size === 'extralarge' || i.size === 'large')?.['#text'];
                // storePrimaryCoverArt will now only use largeLfmUrl if no cover is already set for coverArtIdForAlbum
                // from embedded/local files.
                await storePrimaryCoverArt(coverArtIdForAlbum, largeLfmUrl);

                let sShareId: string | null = null, mShareId: string | null = null, lShareId: string | null = null;
                const primaryCoverExists = (await database.get(['covers', coverArtIdForAlbum])).value;

                if (primaryCoverExists) {
                    // Create shares only if there's a corresponding image size hint from Last.fm
                    // deno-lint-ignore no-explicit-any
                    if (lfmData.image?.some((i: any) => i.size === 'small')) {
                        sShareId = await createOrGetCoverArtShare(
                            coverArtIdForAlbum,
                            systemUserIdForShares,
                            `Small cover for album: ${album.subsonic.name}`,
                        );
                    }
                    // deno-lint-ignore no-explicit-any
                    if (lfmData.image?.some((i: any) => i.size === 'medium')) {
                        mShareId = await createOrGetCoverArtShare(
                            coverArtIdForAlbum,
                            systemUserIdForShares,
                            `Medium cover for album: ${album.subsonic.name}`,
                        );
                    }
                    // deno-lint-ignore no-explicit-any
                    if (lfmData.image?.some((i: any) => i.size === 'extralarge' || i.size === 'large')) {
                        lShareId = await createOrGetCoverArtShare(
                            coverArtIdForAlbum,
                            systemUserIdForShares,
                            `Large cover for album: ${album.subsonic.name}`,
                        );
                    }
                }

                const newAlbumInfo = AlbumInfoSchema.safeParse({
                    notes: lfmData.wiki?.summary || lfmData.wiki?.content || album.albumInfo?.notes || '',
                    musicBrainzId: lfmData.mbid || album.subsonic.musicBrainzId,
                    lastFmUrl: lfmData.url,
                    smallImageUrl: sShareId ? `/api/public-cover/${coverArtIdForAlbum}?size=100` : undefined,
                    mediumImageUrl: mShareId ? `/api/public-cover/${coverArtIdForAlbum}?size=300` : undefined,
                    largeImageUrl: lShareId ? `/api/public-cover/${coverArtIdForAlbum}?size=600` : undefined,
                });

                if (newAlbumInfo.success) {
                    album.albumInfo = newAlbumInfo.data;
                    if (newAlbumInfo.data.musicBrainzId && !album.subsonic.musicBrainzId) {
                        album.subsonic.musicBrainzId = newAlbumInfo.data.musicBrainzId;
                    }
                    // Ensure album.subsonic.coverArt is set if a primary cover was established.
                    // This is typically album.subsonic.id.
                    if (primaryCoverExists && !album.subsonic.coverArt) {
                        album.subsonic.coverArt = coverArtIdForAlbum;
                    }
                }
                album.backend.lastFM = true;
                const validatedAlbum = AlbumSchema.safeParse(album);
                if (validatedAlbum.success) await database.set(['albums', album.subsonic.id], validatedAlbum.data);
            }
        }

        // ARTISTS
        for await (const artistDbEntry of database.list({ prefix: ['artists'] })) {
            const artistParseResult = ArtistSchema.safeParse(artistDbEntry.value);
            if (!artistParseResult.success) continue;
            const artist = artistParseResult.data;

            if (artist.lastFM && artist.artistInfo?.smallImageUrl?.startsWith('/api/public-cover')) {
                continue; // Already processed with local URLs
            }

            const lfmArtistInfo = await getArtistInfo(artist.artist.name); // Fetch Last.fm info first
            const coverArtIdForArtist = artist.artist.id;
            let primaryExternalUrlToStore: string | undefined = undefined;

            // Initialize with Last.fm large image as a fallback
            if (lfmArtistInfo && lfmArtistInfo.artist) {
                // deno-lint-ignore no-explicit-any
                primaryExternalUrlToStore = lfmArtistInfo.artist.image?.find((i: any) =>
                    i.size === 'extralarge' || i.size === 'large' || i.size === 'mega'
                )?.['#text'];
            }

            // Check Spotify and prioritize it
            let spotifyImages: { size: string; url: string }[] = [];
            if (config.spotify?.enabled && config.spotify.client_id && config.spotify.client_secret) {
                spotifyImages = await getArtistCover(artist.artist.name, database, config.spotify.client_id, config.spotify.client_secret);
                if (spotifyImages && spotifyImages.length > 0) {
                    // Prioritize Spotify: Use large, then medium, then small if available
                    const spotifyLarge = spotifyImages.find((img) => img.size === 'large')?.url;
                    const spotifyMedium = spotifyImages.find((img) => img.size === 'medium')?.url;
                    const spotifySmall = spotifyImages.find((img) => img.size === 'small')?.url;

                    if (spotifyLarge) {
                        primaryExternalUrlToStore = spotifyLarge;
                        logger.debug(`Prioritizing Spotify large image for artist ${artist.artist.name}`);
                    } else if (spotifyMedium) {
                        primaryExternalUrlToStore = spotifyMedium;
                        logger.debug(`Prioritizing Spotify medium image for artist ${artist.artist.name}`);
                    } else if (spotifySmall) {
                        primaryExternalUrlToStore = spotifySmall;
                        logger.debug(`Prioritizing Spotify small image for artist ${artist.artist.name}`);
                    }
                    // If primaryExternalUrlToStore was updated by Spotify, storePrimaryCoverArt will use it.
                    // If no Spotify images, it remains the Last.fm URL (if any).
                }
            }

            // Store the chosen primary cover art.
            // storePrimaryCoverArt will only actually download/write if no cover already exists for this artist.
            if (primaryExternalUrlToStore) {
                await storePrimaryCoverArt(coverArtIdForArtist, primaryExternalUrlToStore);
            } else {
                // If no external URL from Spotify or LastFM, storePrimaryCoverArt might still find
                // an embedded/local one if this function were called from initialScan, but here it's less likely.
                // We still call it to ensure the ['covers', artistId] entry is checked or created if needed.
                await storePrimaryCoverArt(coverArtIdForArtist, undefined);
            }

            let sShareId: string | null = null, mShareId: string | null = null, lShareId: string | null = null;
            const primaryCoverExists = (await database.get(['covers', coverArtIdForArtist])).value;

            if (primaryCoverExists) {
                // For creating shares, check availability from both Spotify and Last.fm for each size
                const hasSmallSpotify = spotifyImages.find((img) => img.size === 'small')?.url;
                // deno-lint-ignore no-explicit-any
                const hasSmallLfm = lfmArtistInfo?.artist?.image?.find((i: any) => i.size === 'small')?.['#text'];
                if (hasSmallSpotify || hasSmallLfm) {
                    sShareId = await createOrGetCoverArtShare(
                        coverArtIdForArtist,
                        systemUserIdForShares,
                        `Small cover for artist: ${artist.artist.name}`,
                    );
                }

                const hasMediumSpotify = spotifyImages.find((img) => img.size === 'medium')?.url;
                // deno-lint-ignore no-explicit-any
                const hasMediumLfm = lfmArtistInfo?.artist?.image?.find((i: any) => i.size === 'medium')?.['#text'];
                if (hasMediumSpotify || hasMediumLfm) {
                    mShareId = await createOrGetCoverArtShare(
                        coverArtIdForArtist,
                        systemUserIdForShares,
                        `Medium cover for artist: ${artist.artist.name}`,
                    );
                }

                // Large share is created if a primary external URL was successfully processed and stored,
                // or if a primary cover existed from other means.
                if (primaryExternalUrlToStore || primaryCoverExists) { // primaryExternalUrlToStore indicates we *tried* to get one.
                    lShareId = await createOrGetCoverArtShare(
                        coverArtIdForArtist,
                        systemUserIdForShares,
                        `Large cover for artist: ${artist.artist.name}`,
                    );
                }
            }

            // Construct artistInfo with the new proxied URLs
            if (lfmArtistInfo && lfmArtistInfo.artist) { // Still need LFM for bio, similar artists etc.
                const lfmData = lfmArtistInfo.artist;
                const newArtistInfo = ArtistInfoSchema.safeParse({
                    id: artist.artist.id,
                    biography: lfmData.bio?.summary || lfmData.bio?.content || artist.artistInfo?.biography || '',
                    musicBrainzId: lfmData.mbid || artist.artist.musicBrainzId,
                    lastFmUrl: lfmData.url,
                    smallImageUrl: sShareId ? `/api/public-cover/${coverArtIdForArtist}?size=100` : undefined,
                    mediumImageUrl: mShareId ? `/api/public-cover/${coverArtIdForArtist}?size=300` : undefined,
                    largeImageUrl: lShareId ? `/api/public-cover/${coverArtIdForArtist}?size=600` : undefined,
                    // deno-lint-ignore no-explicit-any
                    similarArtist: lfmData.similar?.artist?.map((sa: any) => sa.name).filter(Boolean) || artist.artistInfo?.similarArtist || [],
                });

                if (newArtistInfo.success) {
                    artist.artistInfo = newArtistInfo.data;
                    if (newArtistInfo.data.musicBrainzId && !artist.artist.musicBrainzId) {
                        artist.artist.musicBrainzId = newArtistInfo.data.musicBrainzId;
                    }
                    // If a primary cover (from any source) now exists for this artist, link it
                    if (primaryCoverExists) {
                        artist.artist.artistImageUrl = artist.artistInfo.largeImageUrl || artist.artistInfo.mediumImageUrl ||
                            artist.artistInfo.smallImageUrl || artist.artist.artistImageUrl;
                        artist.artist.coverArt = coverArtIdForArtist;
                    }
                }
            }
            artist.lastFM = true; // Mark as processed for LFM text data, even if images came from Spotify
            const validatedArtist = ArtistSchema.safeParse(artist);
            if (validatedArtist.success) {
                await database.set(['artists', artist.artist.id], validatedArtist.data);
                logger.debug(`Updated metadata (with local image URLs) for artist: ${artist.artist.name}`);
            } else {
                logger.error(
                    `Failed to re-validate artist ${artist.artist.name} after LFM/Spotify update: ${JSON.stringify(validatedArtist.error.issues)}`,
                );
            }
        }
        logger.info('Finished Last.fm metadata fetch and cover share creation.');
    }
}

async function extractMetadata(filePath: string, trackId: string): Promise<Song | undefined> {
    try {
        const stat = await Deno.stat(filePath);
        const lastModified = stat.mtime?.getTime() ?? Date.now();

        const existingEntry = await database.get(['tracks', trackId]);
        if (existingEntry.value) {
            const existingSong = SongSchema.safeParse(existingEntry.value);
            if (existingSong.success && existingSong.data.backend.lastModified === lastModified) {
                return;
            }
        }

        logger.info(`🔍 Extracting metadata for ${filePath}`);
        const metadata = await parseFile(filePath, { duration: true, skipCovers: false });

        const artists = await handleArtist(metadata.common.artist || 'Unknown Artist');
        const albumArtists = metadata.common.albumartist ? await handleArtist(metadata.common.albumartist) : artists;

        const albumName = metadata.common.album || 'Unknown Album';
        const albumId = await getAlbumIDByName(albumName, albumArtists) || await generateId();

        // This call ensures album entry exists and its subsonic.coverArt points to albumId
        await handleAlbum(albumId, trackId, albumArtists, metadata);

        // Attempt to store primary cover from embedded/local file sources during initial scan.
        // This is the first opportunity to set a cover.
        await storePrimaryCoverArt(albumId, undefined, metadata.common.picture, filePath);

        const genres: Genre[] | undefined = metadata.common.genre?.flatMap((g: string) =>
            g.split(separatorsToRegex(config.genre_separators)).map((name: string) => ({ name: name.trim() }))
        ).filter((g) =>
            g.name && g.name.length > 0
        ) || undefined;

        const replayGainParsed = ReplayGainSchema.safeParse({/* ... */});
        const fileExtension = (filePath.split('.').pop() || 'mp3').toLowerCase();
        const contentTypeMap: Record<string, string> = {/* ... */};
        const lyricsArray: StructuredLyrics[] = [];
        // ... (lyrics parsing logic as before) ...
        if (metadata.common.lyrics?.length) {
            for (const lyricItem of metadata.common.lyrics) {
                if (lyricItem.syncText?.length) {
                    const lines = lyricItem.syncText.map((line) => ({ start: line.timestamp, value: line.text }));
                    const parsed = StructuredLyricsSchema.safeParse({
                        displayArtist: artists[0]?.name || 'Unknown Artist',
                        displayTitle: metadata.common.title || path.parse(filePath).name,
                        synced: true,
                        line: lines,
                    });
                    if (parsed.success) lyricsArray.push(parsed.data);
                } else if (lyricItem.text) {
                    const lines = lyricItem.text.split('\n').map((lineText) => ({ value: lineText }));
                    const parsed = StructuredLyricsSchema.safeParse({
                        displayArtist: artists[0]?.name || 'Unknown Artist',
                        displayTitle: metadata.common.title || path.parse(filePath).name,
                        synced: false,
                        line: lines,
                    });
                    if (parsed.success) lyricsArray.push(parsed.data);
                }
            }
        }

        const songData = {
            backend: { lastModified: lastModified, lastFM: false, lyrics: lyricsArray },
            subsonic: {
                id: trackId,
                title: metadata.common.title || path.parse(filePath).name,
                album: albumName,
                artist: artists[0]?.name || 'Unknown Artist',
                track: metadata.common.track.no || undefined,
                year: metadata.common.year || undefined,
                genre: genres?.map((g) => g.name).join(', ') || undefined,
                coverArt: albumId, // Track uses album's coverArt ID
                size: stat.size,
                contentType: contentTypeMap[fileExtension] || 'application/octet-stream',
                suffix: fileExtension,
                duration: Math.round(metadata.format.duration || 0),
                bitRate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : undefined,
                bitDepth: metadata.format.bitsPerSample,
                samplingRate: metadata.format.sampleRate,
                channelCount: metadata.format.numberOfChannels,
                path: filePath,
                isVideo: false,
                discNumber: metadata.common.disk.no || 1,
                created: new Date(stat.birthtime || stat.mtime || Date.now()).toISOString(),
                albumId: albumId,
                artistId: artists[0]?.id || undefined,
                type: 'music',
                musicBrainzId: metadata.common.musicbrainz_trackid,
                genres: genres,
                artists: artists,
                albumArtists: albumArtists,
                displayArtist: artists.length > 1
                    ? artists.slice(0, -1).map((a) => a.name).join(', ') + ' & ' + artists[artists.length - 1].name
                    : artists[0]?.name || '',
                displayAlbumArtist: albumArtists.length > 1
                    ? albumArtists.slice(0, -1).map((a) => a.name).join(', ') + ' & ' + albumArtists[albumArtists.length - 1].name
                    : albumArtists[0]?.name || '',
                replayGain: replayGainParsed.success ? replayGainParsed.data : undefined,
            },
        };
        const songParseResult = SongSchema.safeParse(songData);
        if (songParseResult.success) {
            return songParseResult.data;
        } else {
            logger.error(`❌ Failed to validate song metadata for ${filePath}:`);
            songParseResult.error.issues.forEach((issue) => logger.error(`  ${issue.path.join('.')}: ${issue.message}`));
        }
        // deno-lint-ignore no-explicit-any
    } catch (error: any) {
        logger.error(`❌ Failed to extract metadata for ${filePath}: ${error.message}`);
    }
    return undefined;
}

export async function syncUserLovedTracksWithTimestamp(user: User, lastFMUsername: string) {
    // ... (syncUserLovedTracksWithTimestamp logic remains the same)
    if (!config.last_fm?.enable_scrobbling || !config.last_fm.api_key || !config.last_fm.api_secret || !user.backend.lastFMSessionKey) {
        logger.info(`Last.fm Timestamp Sync for ${lastFMUsername}: Syncing/scrobbling disabled or user session key/API secret missing.`);
        return;
    }
    logger.info(`🔄 Starting Timestamp-Aware Last.fm sync for user ${lastFMUsername}...`);
    const connectedToInternet = await checkInternetConnection();
    if (!connectedToInternet) {
        logger.warn(`Last.fm Timestamp Sync for ${lastFMUsername}: No internet connection.`);
        return;
    }
    const remoteLovedMap = await getUserLovedTracksMap(lastFMUsername);
    if (remoteLovedMap === null) {
        logger.error(`Last.fm Timestamp Sync for ${lastFMUsername}: Failed to fetch loved tracks from Last.fm. Aborting sync.`);
        return;
    }
    let pushedLove = 0, pushedUnlove = 0, pulledStar = 0, pulledDateUpdate = 0, skipped = 0, errors = 0;
    const processedRemoteKeys = new Set<string>();
    for await (const entry of database.list({ prefix: ['userData', user.backend.id, 'track'] })) {
        const trackId = entry.key[3] as string;
        const userDataParseResult = userDataSchema.safeParse(entry.value);
        if (!userDataParseResult.success) {
            errors++;
            continue;
        }
        const localUserData = userDataParseResult.data;
        const localStarredDate = localUserData.starred ? new Date(localUserData.starred) : null;
        const localUnstarredDate = localUserData.unstarred ? new Date(localUserData.unstarred) : null;
        let isEffectivelyStarredLocally = false;
        if (localStarredDate && (!localUnstarredDate || localStarredDate.getTime() >= localUnstarredDate.getTime())) {
            isEffectivelyStarredLocally = true;
        }
        const trackEntry = await database.get(['tracks', trackId]);
        const trackDataParseResult = SongSchema.safeParse(trackEntry.value);
        if (!trackDataParseResult.success) {
            errors++;
            continue;
        }
        const trackData = trackDataParseResult.data;
        const artistName = trackData.subsonic.artist;
        const trackTitle = trackData.subsonic.title;
        const remoteMapKey = createTrackMapKey(artistName, trackTitle);
        const remoteLoveTimestampUTS = remoteLovedMap.get(remoteMapKey);
        const isLovedRemotely = !!remoteLoveTimestampUTS;
        const remoteLoveTimestampMillis = isLovedRemotely ? remoteLoveTimestampUTS * 1000 : 0;
        if (isLovedRemotely) processedRemoteKeys.add(remoteMapKey);
        try {
            if (isEffectivelyStarredLocally && !isLovedRemotely) {
                const success = await setTrackLoveStatus(user, artistName, trackTitle, true);
                if (success) pushedLove++;
                else errors++;
            } else if (!isEffectivelyStarredLocally && isLovedRemotely) {
                if (localUnstarredDate && localUnstarredDate.getTime() > remoteLoveTimestampMillis) {
                    const success = await setTrackLoveStatus(user, artistName, trackTitle, false);
                    if (success) pushedUnlove++;
                    else errors++;
                } else {
                    const remoteLoveDate = new Date(remoteLoveTimestampMillis);
                    const updatedUserData = { ...localUserData, starred: remoteLoveDate, unstarred: null };
                    const validationResult = userDataSchema.safeParse(updatedUserData);
                    if (validationResult.success) {
                        await database.set(entry.key, validationResult.data);
                        pulledStar++;
                    } else errors++;
                }
            } else if (isEffectivelyStarredLocally && isLovedRemotely) {
                if (!localStarredDate) {
                    errors++;
                    continue;
                } // Should not happen
                const localTimestampMillis = localStarredDate.getTime();
                if (remoteLoveTimestampMillis > localTimestampMillis) {
                    const remoteLoveDate = new Date(remoteLoveTimestampMillis);
                    const updatedUserData = { ...localUserData, starred: remoteLoveDate, unstarred: null };
                    const validationResult = userDataSchema.safeParse(updatedUserData);
                    if (validationResult.success) {
                        await database.set(entry.key, validationResult.data);
                        pulledDateUpdate++;
                    } else errors++;
                } else skipped++;
            } else skipped++;
        } catch (_) {
            errors++;
        }
    }
    for (const [remoteKey, _] of remoteLovedMap.entries()) {
        if (!processedRemoteKeys.has(remoteKey)) {
            // Logic for remote-only loves (potentially find local track and star it)
            // This part is complex if tracks aren't perfectly matched by name.
            // For now, we can log or skip.
            skipped++;
        }
    }
    logger.info(
        `🔄 Finished LFM Sync for ${lastFMUsername}. Sent: ${pushedLove}❤️ ${pushedUnlove}💔. Pulled: ${pulledStar}⭐. Updated: ${pulledDateUpdate}📅. Skipped: ${skipped}. Errors: ${errors}.`,
    );
}

export async function syncAllConfiguredUsersFavoritesToLastFM() {
    if (!config.last_fm?.enable_scrobbling) {
        logger.info('Last.fm All Users Sync: Disabled globally.');
        return;
    }
    logger.info('Starting Last.fm favorites sync for all configured users...');
    let usersFound = 0;
    for await (const entry of database.list({ prefix: ['users'] })) {
        const userParseResult = UserSchema.safeParse(entry.value);
        if (userParseResult.success) {
            const user = userParseResult.data;
            usersFound++;
            if (user.backend?.lastFMSessionKey && config.last_fm.api_key && config.last_fm.api_secret) {
                const fetchedUsername = await getUsernameFromSessionKey(user.backend.lastFMSessionKey);
                if (fetchedUsername) {
                    await syncUserLovedTracksWithTimestamp(user, fetchedUsername);
                } else {
                    logger.warn(`Could not fetch LFM username for user ${user.subsonic?.username || user.backend.id}. Skipping sync.`);
                }
            }
        }
    }
    if (usersFound === 0) logger.warn('LFM All Users Sync: No users found.');
    logger.info('Finished LFM favorites sync cycle.');
}

export function GetScanStatus(): ScanStatus {
    return scanStatus;
}
export function StartScan(): ScanStatus {
    scanMediaDirectories(config.music_folders).catch((err) => {
        logger.error('Error during StartScan -> scanMediaDirectories:', err);
        scanStatus.scanning = false;
    });
    return scanStatus;
}
