// MediaScanner.ts
import { walk } from '@std/fs';
import { IAudioMetadata, IPicture, parseFile } from 'music-metadata';
import * as path from '@std/path';
import { checkInternetConnection, config, database, generateId, logger, separatorsToRegex } from './util.ts';
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
    ShareSchema,
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
import { updatePlaylistCover } from './PlaylistManager.ts';

const seenFiles = new Set<string>();

const artistNameToIdCache = new Map<string, string>();
const albumNameArtistToIdCache = new Map<string, string>();

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

async function createOrGetCoverArtShare(
    coverArtId: string,
    userIdForShare: string,
    description: string,
): Promise<string | null> {
    for await (const entry of database.list({ prefix: ['shares'] })) {
        const existingShareResult = ShareSchema.safeParse(entry.value);
        if (
            existingShareResult.success && existingShareResult.data.itemType === 'coverArt' &&
            existingShareResult.data.itemId === coverArtId && existingShareResult.data.description === description &&
            existingShareResult.data.userId === userIdForShare
        ) {
            return existingShareResult.data.id;
        }
    }
    const shareId = await generateId(12);
    const newShareData = {
        id: shareId,
        userId: userIdForShare,
        itemId: coverArtId,
        itemType: 'coverArt',
        description: description,
        created: new Date(),
        expires: null,
        viewCount: 0,
    };
    const newShare = ShareSchema.safeParse(newShareData);
    if (newShare.success) {
        await database.set(['shares', shareId], newShare.data);
        logger.debug(`Created internal coverArt share ${shareId} for ${coverArtId} (${description})`);
        return shareId;
    } else {
        logger.error(`Failed to validate new internal coverArt share for ${coverArtId}: ${JSON.stringify(newShare.error.issues)}`);
        return null;
    }
}

export async function hardReset() {
    logger.warn('Hard resetting all track, album, and artist metadata!');
    const kv = database;
    const prefixesToClear: Deno.KvKeyPart[][] = [
        ['tracks'],
        ['albums'],
        ['artists'],
        ['covers'],
        ['filePathToId'],
        ['shares'],
        // ['counters'] was removed as per your version, but if needed, add back.
        // Be cautious if other parts of the system rely on counters without re-initializing them.
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

    artistNameToIdCache.clear();
    albumNameArtistToIdCache.clear();

    await cleanupDatabase(); // Run cleanup after clearing main data.
    logger.info('Hard reset done. Starting scan now...');
    await scanMediaDirectories(config.music_folders);
}

export async function scanMediaDirectories(directories: string[], cleanup: boolean = true, debug_log: boolean = false) {
    if (scanStatus.scanning) {
        logger.warn('Scan already in progress.');
        return scanStatus;
    }
    scanStatus = { scanning: true, count: 0, totalFiles: 0, lastScan: new Date() };
    artistNameToIdCache.clear();

    for (const dir of directories) {
        logger[debug_log ? 'debug' : 'info'](`🔍 Scanning directory: ${dir}`);
        await scanDirectory(dir);
    }
    if (cleanup) await cleanupDatabase();
    await handleLastFMMetadata();
    await syncAllConfiguredUsersFavoritesToLastFM();
    seenFiles.clear();
    scanStatus.scanning = false;
    logger[debug_log ? 'debug' : 'info']('✅ Media scan complete.');
    return scanStatus;
}

async function cleanupDatabase() {
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
                logger.info(`⚠️ Track missing in filePathToId: ${trackId}, path: ${track.subsonic.path}. Deleting track.`);
                await database.delete(['tracks', trackId]);
            } else {
                seenTrackIds.add(trackId);
                if (track.subsonic.albumId) albumsInUse.add(track.subsonic.albumId);
                if (track.subsonic.coverArt) coversInUse.add(track.subsonic.coverArt);
                for (const artist of track.subsonic.artists) artistsInUse.add(artist.id);
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
            for (const artist of album.subsonic.artists) artistsInUse.add(artist.id);
            const originalSongCount = album.subsonic.song.length;
            album.subsonic.song = album.subsonic.song.filter((songIdOrObj) => {
                const id = typeof songIdOrObj === 'string' ? songIdOrObj : (songIdOrObj as { id: string }).id;
                return seenTrackIds.has(id);
            });
            if (album.subsonic.song.length !== originalSongCount) {
                album.subsonic.songCount = album.subsonic.song.length;
                await database.set(albumEntry.key, album);
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
            if (artistResult.data.artist.coverArt) coversInUse.add(artistResult.data.artist.coverArt);
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
                logger.info(`📝 Updated playlist "${playlist.name}", removed missing tracks.`);
                await database.set(['playlists', playlist.id], playlist);
            }

            if (playlist.coverArt) coversInUse.add(playlist.id)
            if (await updatePlaylistCover(playlist.id)) coversInUse.add(playlist.id);

        } else {
            logger.warn(`Data for playlist ID ${String(playlistEntry.key[1])} did not match PlaylistSchema.`);

        }
    }

    for await (const coverEntry of database.list({ prefix: ['covers'] })) {
        const coverId = coverEntry.key[1] as string;
        if (!coversInUse.has(coverId)) {
            logger.info(`❌ Removing orphaned cover: ${coverId} and its shares.`);
            await database.delete(coverEntry.key);
            for await (const shareEntry of database.list({ prefix: ['shares'] })) {
                const shareResult = ShareSchema.safeParse(shareEntry.value);
                if (shareResult.success && shareResult.data.itemType === 'coverArt' && shareResult.data.itemId === coverId) {
                    await database.delete(shareEntry.key);
                    logger.debug(`Deleted share ${shareResult.data.id} for orphaned cover ${coverId}`);
                }
            }
        }
    }

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

    seenTrackIds.clear();
    albumsInUse.clear();
    artistsInUse.clear();
    coversInUse.clear();
}

async function scanDirectory(dir: string) {
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
    const normalizedName = name.toLowerCase().trim();

    if (artistNameToIdCache.has(normalizedName)) return artistNameToIdCache.get(normalizedName);

    for await (const entry of database.list({ prefix: ['artists'] })) {
        const artistParseResult = ArtistSchema.safeParse(entry.value);
        if (artistParseResult.success && artistParseResult.data.artist.name.toLowerCase().trim() === normalizedName) {
            const id = artistParseResult.data.artist.id;
            artistNameToIdCache.set(normalizedName, id);
            return id;
        }
    }

    return undefined;
}

async function getAlbumIDByName(name: string, artists?: AlbumID3Artists[]): Promise<string | undefined> {
    const normalizedName = name.toLowerCase().trim();
    const cacheKey = artists?.length
        ? `${normalizedName}|${artists.map(a => a.name.toLowerCase().trim()).sort().join('|')}`
        : normalizedName;

    if (albumNameArtistToIdCache.has(cacheKey)) return albumNameArtistToIdCache.get(cacheKey);

    for await (const { value } of database.list({ prefix: ['albums'] })) {
        const parsedEntry = AlbumSchema.safeParse(value);
        if (!parsedEntry.success || parsedEntry.data.subsonic.name.toLowerCase().trim() !== normalizedName) continue;
        if (
            !artists?.length ||
            parsedEntry.data.subsonic.artists.some((albumArtist) =>
                artists.some((a) => a.name.toLowerCase().trim() === albumArtist.name.toLowerCase().trim())
            )
        ) {
            const id = parsedEntry.data.subsonic.id;
            albumNameArtistToIdCache.set(cacheKey, id);
            return id;
        }
    }

    return undefined;
}

async function storePrimaryCoverArt(
    itemId: string,
    externalUrl?: string,
    pictures?: IPicture[],
    trackPath?: string,
): Promise<string | null> {
    const coversDir = path.join(config.data_folder, 'covers');
    await Deno.mkdir(coversDir, { recursive: true }).catch(() => { });
    const mimeToExt: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
    };

    const existingCoverEntry = await database.get(['covers', itemId]);
    if (existingCoverEntry.value) {
        const parsedExisting = CoverArtSchema.safeParse(existingCoverEntry.value);
        if (parsedExisting.success && await exists(parsedExisting.data.path)) {
            logger.debug(`Primary cover for ${itemId} already exists at ${parsedExisting.data.path}. Using existing.`);
            return parsedExisting.data.path;
        } else {
            logger.warn(`Cover for ${itemId} in DB but file missing at ${parsedExisting.data?.path || 'unknown path'}. Attempting to re-acquire.`);
        }
    }

    let coverData: { data: Uint8Array; format: string } | null = null;
    let newCoverSource = '';

    if (pictures && pictures.length > 0) {
        const pic = pictures.find((p) => p.type?.toLowerCase().includes('cover (front)')) || pictures.find((p) =>
            p.type?.toLowerCase().startsWith('cover')
        ) || pictures[0];
        if (pic) {
            coverData = { data: pic.data, format: pic.format };
            newCoverSource = 'embedded image';
        }
    }

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
                        : (externalUrl.includes('last.fm') || externalUrl.includes('audioscrobbler'))
                            ? 'Last.fm'
                            : 'external URL';
                } else logger.warn(`Skipping download for ${itemId} from ${externalUrl}: Content-Type not an image (${contentType})`);
            } else logger.warn(`Failed to download cover for ${itemId} from ${externalUrl}: ${response.status}`);
            // deno-lint-ignore no-explicit-any
        } catch (e: any) {
            logger.error(`Error downloading ${externalUrl} for ${itemId}: ${e.message}`);
        }
    }

    if (coverData) {
        const ext = mimeToExt[coverData.format.toLowerCase()] || 'jpg';
        const finalPath = path.join(coversDir, `${itemId}.${ext}`);
        try {
            await Deno.writeFile(finalPath, coverData.data);
            const newCoverArtEntry = CoverArtSchema.safeParse({ id: itemId, mimeType: coverData.format, path: finalPath });
            if (newCoverArtEntry.success) {
                await database.set(['covers', itemId], newCoverArtEntry.data);
                logger.info(`Stored primary cover for ${itemId} (from ${newCoverSource || 'unknown'}) at ${finalPath}`);
                return finalPath;
            } else logger.error(`Failed to validate CoverArt entry for ${itemId}: ${JSON.stringify(newCoverArtEntry.error.issues)}`);
        } catch (e) {
            logger.error(`Error writing cover file ${finalPath} for ${itemId}: ${e}`);
        }
    }
    logger.warn(`No cover art ultimately processed or stored for ${itemId}.`);
    return null;
}

async function handleAlbum(albumId: string, trackId: string, albumArtists: AlbumID3Artists[], metadata: IAudioMetadata) {
    const albumEntry = await database.get(['albums', albumId]);
    const existingAlbumParse = AlbumSchema.safeParse(albumEntry.value);
    const existingAlbum = existingAlbumParse.success ? existingAlbumParse.data : null;

    if (existingAlbum) {
        let changes = false;
        const songSet = new Set(
            existingAlbum.subsonic.song.map((s) => (typeof s === 'string' ? s : (s as Song).subsonic.id || (s as { id: string }).id)).filter(Boolean),
        );
        if (!songSet.has(trackId)) {
            existingAlbum.subsonic.song.push(trackId);
            existingAlbum.subsonic.songCount = existingAlbum.subsonic.song.length;
            existingAlbum.subsonic.duration = Math.round(existingAlbum.subsonic.duration + (metadata.format.duration || 0));
            changes = true;
        }
        if (!existingAlbum.subsonic.discTitles.find((disc) => disc.disc === (metadata.common.disk.no || 1))) {
            existingAlbum.subsonic.discTitles.push({ disc: metadata.common.disk.no || 1, title: `Disc ${metadata.common.disk.no || 1}` });
            changes = true;
        }
        for (const newArtist of albumArtists) {
            if (!existingAlbum.subsonic.artists.some((a) => a.id === newArtist.id)) {
                existingAlbum.subsonic.artists.push(newArtist);
                changes = true;
            }
        }
        for (const currentAlbumArtist of existingAlbum.subsonic.artists) {
            const artistEntry = await database.get(['artists', currentAlbumArtist.id]);
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
            coverArt: albumId,
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
    } else logger.error(`Failed to validate new album ${albumId}: ${albumParseResult.error.issues}`);
}

async function handleArtist(artistString: string, artistArray: string[] = []): Promise<AlbumID3Artists[]> {
    const allSources = [];

    if (artistString && artistString !== 'Unknown Artist') allSources.push(artistString);
    if (artistArray.length) allSources.push(...artistArray);

    const unsortedNames = allSources
        .flatMap(source => source.split(separatorsToRegex(config.artist_separators)))
        .map(name => name.trim())
        .filter(name => name.length > 0);

    const uniqueNames = [...new Set(unsortedNames)];

    const sortedArtists: AlbumID3Artists[] = [];
    for (const name of uniqueNames) {
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
            const newArtistArtistPart = ArtistID3Schema.safeParse({ id, name: trimmedName, coverArt: id, albumCount: 0, album: [] });
            if (newArtistArtistPart.success) {
                const newArtistFull = ArtistSchema.safeParse({ artist: newArtistArtistPart.data, lastFM: false });
                if (newArtistFull.success) {
                    await database.set(['artists', id], newArtistFull.data);
                    artistData = newArtistFull.data;
                } else logger.error(`Failed to validate new full artist ${trimmedName}: ${newArtistFull.error.issues}`);
            } else logger.error(`Failed to validate new artist part ${trimmedName}: ${newArtistArtistPart.error.issues}`);
        }
        if (artistData) sortedArtists.push({ id: artistData.artist.id, name: artistData.artist.name });
    }
    return sortedArtists;
}

async function handleLastFMMetadata() {
    const connectedToInternet = await checkInternetConnection();
    const systemUserIdForShares = 'dinosonic_system_user_id';

    if (!connectedToInternet || !config.last_fm?.enabled || !config.last_fm.api_key) {
        if (!connectedToInternet) logger.debug('LFM Metadata: No internet connection.');
        else logger.debug('LFM Metadata: Last.fm integration disabled or API key missing.');
        return;
    }

    logger.info('Starting external metadata processing (Last.fm/Spotify covers)...');
    let albumsProcessed = 0, artistsProcessed = 0, albumsSkipped = 0, artistsSkipped = 0;

    // ALBUMS
    for await (const albumEntry of database.list({ prefix: ['albums'] })) {
        const albumParseResult = AlbumSchema.safeParse(albumEntry.value);
        if (!albumParseResult.success) {
            logger.warn(`Skipping malformed album data: ${albumEntry.key.join('/')}`);
            continue;
        }
        const album = albumParseResult.data;
        let hasChangesThisIteration = false;

        const ai = album.albumInfo;
        if (
            album.backend.lastFM && ai && (ai.smallImageUrl === undefined || ai.smallImageUrl.startsWith('/api/public-cover/')) &&
            (ai.mediumImageUrl === undefined || ai.mediumImageUrl.startsWith('/api/public-cover/')) &&
            (ai.largeImageUrl === undefined || ai.largeImageUrl.startsWith('/api/public-cover/'))
        ) {
            albumsSkipped++;
            continue;
        }

        const primaryArtistName = album.subsonic.artists[0]?.name || album.subsonic.artist;
        if (!primaryArtistName) {
            logger.warn(`Skipping LFM for album "${album.subsonic.name}": missing primary artist.`);
            albumsSkipped++;
            continue;
        }

        const lfmAlbumInfoResponse = await getAlbumInfo(album.subsonic.name, primaryArtistName);
        if (lfmAlbumInfoResponse && lfmAlbumInfoResponse.album) {
            const lfmData = lfmAlbumInfoResponse.album;
            const coverArtIdForAlbum = album.subsonic.id;
            const largeLfmUrl = lfmData.image?.find((i: { size: string }) => i.size === 'extralarge' || i.size === 'large')?.['#text'];
            const oldCoverArtPath = (await database.get(['covers', coverArtIdForAlbum])).value
                ? (CoverArtSchema.safeParse((await database.get(['covers', coverArtIdForAlbum])).value)?.data?.path)
                : null;
            await storePrimaryCoverArt(coverArtIdForAlbum, largeLfmUrl);
            const newCoverArtPath = (await database.get(['covers', coverArtIdForAlbum])).value
                ? (CoverArtSchema.safeParse((await database.get(['covers', coverArtIdForAlbum])).value)?.data?.path)
                : null;
            if (newCoverArtPath && oldCoverArtPath !== newCoverArtPath) hasChangesThisIteration = true;

            let sShareId: string | null = null, mShareId: string | null = null, lShareId: string | null = null;
            if (newCoverArtPath) {
                if (lfmData.image?.some((i: { size: string }) => i.size === 'small')) {
                    sShareId = await createOrGetCoverArtShare(
                        coverArtIdForAlbum,
                        systemUserIdForShares,
                        `Small cover for album: ${album.subsonic.name}`,
                    );
                }
                if (lfmData.image?.some((i: { size: string }) => i.size === 'medium')) {
                    mShareId = await createOrGetCoverArtShare(
                        coverArtIdForAlbum,
                        systemUserIdForShares,
                        `Medium cover for album: ${album.subsonic.name}`,
                    );
                }
                if (lfmData.image?.some((i: { size: string }) => i.size === 'extralarge' || i.size === 'large')) {
                    lShareId = await createOrGetCoverArtShare(
                        coverArtIdForAlbum,
                        systemUserIdForShares,
                        `Large cover for album: ${album.subsonic.name}`,
                    );
                }
            }

            const currentAlbumInfo = album.albumInfo || {};
            const newAlbumInfoData = {
                notes: lfmData.wiki?.summary || '', // Only summary, default to ""
                musicBrainzId: lfmData.mbid || album.subsonic.musicBrainzId,
                lastFmUrl: lfmData.url,
                smallImageUrl: sShareId
                    ? `/api/public-cover/${coverArtIdForAlbum}?size=100`
                    : (sShareId === null && newCoverArtPath ? undefined : currentAlbumInfo.smallImageUrl),
                mediumImageUrl: mShareId
                    ? `/api/public-cover/${coverArtIdForAlbum}?size=300`
                    : (mShareId === null && newCoverArtPath ? undefined : currentAlbumInfo.mediumImageUrl),
                largeImageUrl: lShareId
                    ? `/api/public-cover/${coverArtIdForAlbum}?size=600`
                    : (lShareId === null && newCoverArtPath ? undefined : currentAlbumInfo.largeImageUrl),
            };
            if (sShareId === null && newCoverArtPath) newAlbumInfoData.smallImageUrl = undefined;
            if (mShareId === null && newCoverArtPath) newAlbumInfoData.mediumImageUrl = undefined;
            if (lShareId === null && newCoverArtPath) newAlbumInfoData.largeImageUrl = undefined;

            if (JSON.stringify(newAlbumInfoData) !== JSON.stringify(currentAlbumInfo)) hasChangesThisIteration = true;
            const newAlbumInfo = AlbumInfoSchema.safeParse(newAlbumInfoData);
            if (newAlbumInfo.success) album.albumInfo = newAlbumInfo.data;
            else logger.warn(`Failed to parse new album info for ${album.subsonic.name}: ${JSON.stringify(newAlbumInfo.error.issues)}`);

            if (newAlbumInfo.data?.musicBrainzId && album.subsonic.musicBrainzId !== newAlbumInfo.data.musicBrainzId) {
                album.subsonic.musicBrainzId = newAlbumInfo.data.musicBrainzId;
                hasChangesThisIteration = true;
            }
            if (newCoverArtPath && album.subsonic.coverArt !== coverArtIdForAlbum) {
                album.subsonic.coverArt = coverArtIdForAlbum;
                hasChangesThisIteration = true;
            }
        }
        if (!album.backend.lastFM) {
            album.backend.lastFM = true;
            hasChangesThisIteration = true;
        }
        if (hasChangesThisIteration) {
            const validatedAlbum = AlbumSchema.safeParse(album);
            if (validatedAlbum.success) {
                await database.set(['albums', album.subsonic.id], validatedAlbum.data);
                logger.debug(`Updated LFM/cover metadata for album: ${album.subsonic.name}`);
                albumsProcessed++;
            } else logger.error(`Failed to save updated album ${album.subsonic.name}: ${JSON.stringify(validatedAlbum.error.issues)}`);
        } else albumsSkipped++;
    }

    // ARTISTS
    for await (const artistDbEntry of database.list({ prefix: ['artists'] })) {
        const artistParseResult = ArtistSchema.safeParse(artistDbEntry.value);
        if (!artistParseResult.success) {
            logger.warn(`Skipping malformed artist data: ${artistDbEntry.key.join('/')}`);
            continue;
        }
        const artist = artistParseResult.data;
        let hasChangesThisIteration = false;

        const ai = artist.artistInfo;
        if (
            artist.lastFM && ai && (ai.smallImageUrl === undefined || ai.smallImageUrl.startsWith('/api/public-cover/')) &&
            (ai.mediumImageUrl === undefined || ai.mediumImageUrl.startsWith('/api/public-cover/')) &&
            (ai.largeImageUrl === undefined || ai.largeImageUrl.startsWith('/api/public-cover/'))
        ) {
            artistsSkipped++;
            continue;
        }

        const lfmArtistInfoResponse = await getArtistInfo(artist.artist.name);
        const coverArtIdForArtist = artist.artist.id;
        let primaryExternalUrlToStore: string | undefined = undefined;
        if (lfmArtistInfoResponse && lfmArtistInfoResponse.artist) {
            // deno-lint-ignore no-explicit-any
            primaryExternalUrlToStore = lfmArtistInfoResponse.artist.image?.find((i: any) =>
                i.size === 'extralarge' || i.size === 'large' || i.size === 'mega'
            )?.['#text'];
        }

        let spotifyImages: { size: string; url: string }[] = [];
        if (config.spotify?.enabled && config.spotify.client_id && config.spotify.client_secret) {
            spotifyImages = await getArtistCover(artist.artist.name, database, config.spotify.client_id, config.spotify.client_secret);
            if (spotifyImages && spotifyImages.length > 0) {
                const bestSpotifyUrl = spotifyImages.find((img) => img.size === 'large')?.url || spotifyImages.find((img) =>
                    img.size === 'medium'
                )?.url || spotifyImages.find((img) => img.size === 'small')?.url;
                if (bestSpotifyUrl) primaryExternalUrlToStore = bestSpotifyUrl;
            }
        }

        const oldCoverArtPath = (await database.get(['covers', coverArtIdForArtist])).value
            ? (CoverArtSchema.safeParse((await database.get(['covers', coverArtIdForArtist])).value)?.data?.path)
            : null;
        if (primaryExternalUrlToStore) await storePrimaryCoverArt(coverArtIdForArtist, primaryExternalUrlToStore);
        else await storePrimaryCoverArt(coverArtIdForArtist, undefined);
        const newCoverArtPath = (await database.get(['covers', coverArtIdForArtist])).value
            ? (CoverArtSchema.safeParse((await database.get(['covers', coverArtIdForArtist])).value)?.data?.path)
            : null;
        if (newCoverArtPath && oldCoverArtPath !== newCoverArtPath) hasChangesThisIteration = true;

        let sShareId: string | null = null, mShareId: string | null = null, lShareId: string | null = null;
        if (newCoverArtPath) {
            const hasSmallExt = spotifyImages.find((img) => img.size === 'small')?.url ||
                // deno-lint-ignore no-explicit-any
                lfmArtistInfoResponse?.artist?.image?.find((i: any) => i.size === 'small')?.['#text'];
            if (hasSmallExt) {
                sShareId = await createOrGetCoverArtShare(
                    coverArtIdForArtist,
                    systemUserIdForShares,
                    `Small cover for artist: ${artist.artist.name}`,
                );
            }
            const hasMediumExt = spotifyImages.find((img) => img.size === 'medium')?.url ||
                // deno-lint-ignore no-explicit-any
                lfmArtistInfoResponse?.artist?.image?.find((i: any) => i.size === 'medium')?.['#text'];
            if (hasMediumExt) {
                mShareId = await createOrGetCoverArtShare(
                    coverArtIdForArtist,
                    systemUserIdForShares,
                    `Medium cover for artist: ${artist.artist.name}`,
                );
            }
            if (primaryExternalUrlToStore || newCoverArtPath) {
                lShareId = await createOrGetCoverArtShare(
                    coverArtIdForArtist,
                    systemUserIdForShares,
                    `Large cover for artist: ${artist.artist.name}`,
                );
            }
        }

        if (lfmArtistInfoResponse && lfmArtistInfoResponse.artist) {
            const lfmData = lfmArtistInfoResponse.artist;
            const currentArtistInfo = artist.artistInfo;
            const newArtistInfoData = {
                id: artist.artist.id,
                biography: lfmData.bio?.summary || '', // Only summary, default to ""
                musicBrainzId: lfmData.mbid || artist.artist.musicBrainzId,
                lastFmUrl: lfmData.url,
                smallImageUrl: sShareId
                    ? `/api/public-cover/${coverArtIdForArtist}?size=100`
                    : (sShareId === null && newCoverArtPath ? undefined : currentArtistInfo?.smallImageUrl),
                mediumImageUrl: mShareId
                    ? `/api/public-cover/${coverArtIdForArtist}?size=300`
                    : (mShareId === null && newCoverArtPath ? undefined : currentArtistInfo?.mediumImageUrl),
                largeImageUrl: lShareId
                    ? `/api/public-cover/${coverArtIdForArtist}?size=600`
                    : (lShareId === null && newCoverArtPath ? undefined : currentArtistInfo?.largeImageUrl),
                // deno-lint-ignore no-explicit-any
                similarArtist: lfmData.similar?.artist?.map((sa: any) => sa.name).filter(Boolean) || currentArtistInfo?.similarArtist || [],
            };
            if (sShareId === null && newCoverArtPath) newArtistInfoData.smallImageUrl = undefined;
            if (mShareId === null && newCoverArtPath) newArtistInfoData.mediumImageUrl = undefined;
            if (lShareId === null && newCoverArtPath) newArtistInfoData.largeImageUrl = undefined;

            if (JSON.stringify(newArtistInfoData) !== JSON.stringify(currentArtistInfo)) hasChangesThisIteration = true;
            const newArtistInfo = ArtistInfoSchema.safeParse(newArtistInfoData);
            if (newArtistInfo.success) artist.artistInfo = newArtistInfo.data;
            else logger.warn(`Failed to parse new artist info for ${artist.artist.name}: ${JSON.stringify(newArtistInfo.error.issues)}`);

            if (newArtistInfo?.data?.musicBrainzId && artist.artist.musicBrainzId !== newArtistInfo.data.musicBrainzId) {
                artist.artist.musicBrainzId = newArtistInfo.data.musicBrainzId;
                hasChangesThisIteration = true;
            }
            if (newCoverArtPath) {
                const bestImageUrl = newArtistInfo?.data?.largeImageUrl || newArtistInfo?.data?.mediumImageUrl || newArtistInfo?.data?.smallImageUrl;
                if (artist.artist.artistImageUrl !== bestImageUrl) {
                    artist.artist.artistImageUrl = bestImageUrl;
                    hasChangesThisIteration = true;
                }
                if (artist.artist.coverArt !== coverArtIdForArtist) {
                    artist.artist.coverArt = coverArtIdForArtist;
                    hasChangesThisIteration = true;
                }
            }
        }
        if (!artist.lastFM) {
            artist.lastFM = true;
            hasChangesThisIteration = true;
        }
        if (hasChangesThisIteration) {
            const validatedArtist = ArtistSchema.safeParse(artist);
            if (validatedArtist.success) {
                await database.set(['artists', artist.artist.id], validatedArtist.data);
                logger.debug(`Updated LFM/Spotify/cover metadata for artist: ${artist.artist.name}`);
                artistsProcessed++;
            } else logger.error(`Failed to save updated artist ${artist.artist.name}: ${JSON.stringify(validatedArtist.error.issues)}`);
        } else artistsSkipped++;
    }
    logger.info(
        `Finished external metadata processing. Albums updated: ${albumsProcessed}, skipped: ${albumsSkipped}. Artists updated: ${artistsProcessed}, skipped: ${artistsSkipped}.`,
    );
}

async function extractMetadata(filePath: string, trackId: string): Promise<Song | undefined> {
    try {
        const stat = await Deno.stat(filePath);
        const lastModified = stat.mtime?.getTime() ?? Date.now();
        const existingEntry = await database.get(['tracks', trackId]);
        if (existingEntry.value) {
            const existingSong = SongSchema.safeParse(existingEntry.value);
            if (existingSong.success && existingSong.data.backend.lastModified === lastModified) return;
        }
        logger.info(`🔍 Extracting metadata for ${filePath}`);
        const metadata = await parseFile(filePath, { duration: true, skipCovers: false });
        const artists = await handleArtist(metadata.common.artist || 'Unknown Artist', metadata.common.artists);
        const albumArtists = metadata.common.albumartist ? await handleArtist(metadata.common.albumartist) : artists;
        const albumName = metadata.common.album || 'Unknown Album';
        const albumId = await getAlbumIDByName(albumName, albumArtists) || await generateId();
        await handleAlbum(albumId, trackId, albumArtists, metadata);
        await storePrimaryCoverArt(albumId, undefined, metadata.common.picture, filePath);
        const genres: Genre[] | undefined = metadata.common.genre?.flatMap((g) =>
            g.split(separatorsToRegex(config.genre_separators)).map((name) => ({ name: name.trim() }))
        ).filter((g) =>
            g.name && g.name.length > 0
        ) || undefined;
        const replayGainParsed = ReplayGainSchema.safeParse({
            trackGain: metadata.common.replaygain_track_gain?.dB,
            trackPeak: metadata.common.replaygain_track_peak,
            albumGain: metadata.common.replaygain_album_gain?.dB,
            albumPeak: metadata.common.replaygain_album_peak,
        });
        const fileExtension = (filePath.split('.').pop() || 'mp3').toLowerCase();
        const contentTypeMap: Record<string, string> = {
            'flac': 'audio/flac',
            'mp3': 'audio/mpeg',
            'wav': 'audio/wav',
            'ogg': 'audio/ogg',
            'm4a': 'audio/mp4',
        };
        const lyricsArray: StructuredLyrics[] = [];
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
                    if (parsed.success) {
                        lyricsArray.push(parsed.data);
                    }
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
                coverArt: albumId,
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
        if (songParseResult.success) return songParseResult.data;
        else {
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
    if (!config.last_fm?.enable_scrobbling || !config.last_fm.api_key || !config.last_fm.api_secret || !user.backend.lastFMSessionKey) {
        logger.debug(`LFM Sync for ${lastFMUsername}: Disabled or missing keys/session.`);
        return;
    }
    logger.info(`🔄 Starting LFM loved tracks sync for user ${lastFMUsername}...`);
    if (!(await checkInternetConnection())) {
        logger.warn(`LFM Sync for ${lastFMUsername}: No internet.`);
        return;
    }

    const remoteLovedMap = await getUserLovedTracksMap(lastFMUsername);
    if (remoteLovedMap === null) {
        logger.error(`LFM Sync for ${lastFMUsername}: Failed to fetch loved tracks.`);
        return;
    }

    let pLove = 0, pUnlove = 0, starPulled = 0, dateUpdate = 0, skipped = 0, errors = 0;
    const processedRemote = new Set<string>();

    for await (const entry of database.list({ prefix: ['userData', user.backend.id, 'track'] })) {
        const trackId = entry.key[3] as string;
        const udParse = userDataSchema.safeParse(entry.value);
        if (!udParse.success) {
            logger.warn(`LFM Sync [${lastFMUsername}]: Malformed userData for track ${trackId}.`);
            errors++;
            continue;
        }

        const localUD = udParse.data;
        const localStar = localUD.starred ? new Date(localUD.starred) : null;
        const localUnstar = localUD.unstarred ? new Date(localUD.unstarred) : null;
        const isLocalStar = localStar && (!localUnstar || localStar.getTime() >= localUnstar.getTime());

        const trackEntry = await database.get(['tracks', trackId]);
        const songParse = SongSchema.safeParse(trackEntry.value);
        if (!songParse.success) {
            logger.warn(`LFM Sync [${lastFMUsername}]: Track ${trackId} not found/malformed.`);
            errors++;
            continue;
        }

        const song = songParse.data;
        const artist = song.subsonic.artist;
        const title = song.subsonic.title;
        const remoteKey = createTrackMapKey(artist, title);
        const remoteTsUTS = remoteLovedMap.get(remoteKey);
        const isRemoteLove = !!remoteTsUTS;
        const remoteTsMs = isRemoteLove ? remoteTsUTS * 1000 : 0;

        if (isRemoteLove) processedRemote.add(remoteKey);

        try {
            if (isLocalStar && !isRemoteLove) { // Local: Starred, Remote: Not Loved -> Push Love
                logger.debug(`LFM Sync [${lastFMUsername}]: Loving "${title}" on LFM.`);
                if (await setTrackLoveStatus(user, artist, title, true)) pLove++;
                else errors++;
            } else if (!isLocalStar && isRemoteLove) { // Local: Not Starred, Remote: Loved
                if (localUnstar && localUnstar.getTime() > remoteTsMs) { // Local unstar is NEWER than remote love -> Push Unlove
                    logger.debug(`LFM Sync [${lastFMUsername}]: Unloving "${title}" on LFM (local unstar newer).`);
                    if (await setTrackLoveStatus(user, artist, title, false)) pUnlove++;
                    else errors++;
                } else { // Remote love is newer or no local unstar -> Pull Star to Local
                    const remoteDate = new Date(remoteTsMs);
                    logger.debug(`LFM Sync [${lastFMUsername}]: Starring "${title}" locally from LFM.`);
                    const updatedUD = { ...localUD, starred: remoteDate, unstarred: null };
                    if (userDataSchema.safeParse(updatedUD).success) {
                        await database.set(entry.key, updatedUD);
                        starPulled++;
                    } else {
                        logger.error(`LFM Sync [${lastFMUsername}]: Validation error pulling star for ${trackId}.`);
                        errors++;
                    }
                }
            } else if (isLocalStar && isRemoteLove) { // Both Starred/Loved -> Compare Timestamps
                if (!localStar) {
                    logger.error(`LFM Sync [${lastFMUsername}]: Logic error for ${trackId}.`);
                    errors++;
                    continue;
                }
                if (remoteTsMs > localStar.getTime()) { // Remote is Newer -> Update Local Star Date
                    const remoteDate = new Date(remoteTsMs);
                    logger.debug(`LFM Sync [${lastFMUsername}]: Updating local star date for "${title}" from LFM.`);
                    const updatedUD = { ...localUD, starred: remoteDate, unstarred: null };
                    if (userDataSchema.safeParse(updatedUD).success) {
                        await database.set(entry.key, updatedUD);
                        dateUpdate++;
                    } else {
                        logger.error(`LFM Sync [${lastFMUsername}]: Validation error updating star date for ${trackId}.`);
                        errors++;
                    }
                } else skipped++; // Local is newer or same, do nothing
            } else { // Both Not Starred/Loved -> Do Nothing
                skipped++;
            }
            // deno-lint-ignore no-explicit-any
        } catch (e: any) {
            logger.error(`LFM Sync [${lastFMUsername}]: Error processing track "${title}": ${e.message}`);
            errors++;
        }
    }

    // Process tracks loved on Last.fm but not encountered in local user data iteration
    for (const [remoteKey, remoteLoveTimestampUTS] of remoteLovedMap.entries()) {
        if (!processedRemote.has(remoteKey)) {
            const [artistLower, titleLower] = remoteKey.split('||');
            let foundLocalTrack: Song | null = null;
            // Attempt to find this track in the local library
            for await (const trackEntry of database.list({ prefix: ['tracks'] })) {
                const songParse = SongSchema.safeParse(trackEntry.value);
                if (songParse.success) {
                    const song = songParse.data;
                    if (song.subsonic.artist.toLowerCase() === artistLower && song.subsonic.title.toLowerCase() === titleLower) {
                        foundLocalTrack = song;
                        break;
                    }
                }
            }

            if (foundLocalTrack) {
                const trackId = foundLocalTrack.subsonic.id;
                const userDataKey: Deno.KvKey = ['userData', user.backend.id, 'track', trackId];
                const userDataEntry = await database.get(userDataKey);
                const localUD = userDataSchema.safeParse(userDataEntry.value).success ? userDataSchema.parse(userDataEntry.value) : { id: trackId }; // Create new if doesn't exist

                const localStar = localUD.starred ? new Date(localUD.starred) : null;
                const localUnstar = localUD.unstarred ? new Date(localUD.unstarred) : null;
                const isLocalStar = localStar && (!localUnstar || localStar.getTime() >= localUnstar.getTime());

                if (!isLocalStar) { // If not effectively starred locally, star it
                    const remoteDate = new Date(remoteLoveTimestampUTS * 1000);
                    logger.debug(`LFM Sync [${lastFMUsername}]: Starring "${titleLower}" locally (found as remote-only love).`);
                    const updatedUD = { ...localUD, starred: remoteDate, unstarred: null };
                    const validationResult = userDataSchema.safeParse(updatedUD);
                    if (validationResult.success) {
                        await database.set(userDataKey, validationResult.data);
                        starPulled++;
                    } else {
                        logger.error(`LFM Sync [${lastFMUsername}]: Validation error starring remote-only love for ${trackId}.`);
                        errors++;
                    }
                } else skipped++; // Already starred locally, possibly by a previous sync or manual action.
            } else {
                logger.debug(`LFM Sync [${lastFMUsername}]: Track loved remotely ("${artistLower} - ${titleLower}") not found in local library.`);
                skipped++; // Or could be an error if you expect all LFM loves to match local
            }
        }
    }
    logger.info(
        `🔄 Finished LFM Sync for ${lastFMUsername}. Sent: ${pLove}❤️ ${pUnlove}💔. Pulled: ${starPulled}⭐. Updated: ${dateUpdate}📅. Skipped: ${skipped}. Errors: ${errors}.`,
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
                if (fetchedUsername) await syncUserLovedTracksWithTimestamp(user, fetchedUsername);
                else logger.warn(`Could not fetch LFM username for user ${user.subsonic?.username || user.backend.id}. Skipping sync.`);
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