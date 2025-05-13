// MediaScanner.ts
// Here houses the recursive file scanner and metadata scanner.
import { walk } from '@std/fs';
import { IAudioMetadata, IPicture, parseFile } from 'music-metadata';
import * as path from '@std/path';
import { checkInternetConnection, config, database, exists, generateId, logger, separatorsToRegex } from './util.ts';
import {
    AlbumID3Artists,
    AlbumInfoSchema,
    AlbumReleaseDateSchema,
    AlbumSchema,
    Artist,
    ArtistID3Schema,
    ArtistInfoSchema,
    ArtistSchema,
    CoverArt,
    CoverArtSchema, // CoverArtSchema is the Zod schema, CoverArt is the type
    PlaylistSchema,
    ReplayGainSchema,
    Song,
    SongSchema,
    StructuredLyrics,
    StructuredLyricsSchema,
    User, // UserSchema is the Zod schema, User is the type
    userDataSchema,
    UserSchema, // Import the schema for type checking userData
} from './zod.ts';
import { Genre } from './zod.ts'; // Genre is also a type here
import { createTrackMapKey, getAlbumInfo, getArtistInfo, getUserLovedTracksMap, getUsernameFromSessionKey, setTrackLoveStatus } from './LastFM.ts';
import { getArtistCover } from './Spotify.ts';

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

export async function hardReset() {
    logger.warn('Hard resetting all track, album, and artist metadata!');

    await database.delete(['tracks']);
    await database.delete(['albums']);
    await database.delete(['artists']);
    await database.delete(['covers']);
    await database.delete(['filePathToId']);
    await database.delete(['counters']);

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

    // Pass 1: Process tracks
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
        const track = trackEntry.value as Song | undefined; // Assumes value is Song or undefined

        if (track && SongSchema.safeParse(track).success) { // Added safeParse for robustness
            const filePathEntry = await database.get(['filePathToId', track.subsonic.path]);
            if (!filePathEntry.value) {
                logger.info(`⚠️ Track missing in filePathToId: ${trackId}`);
                await database.delete(['tracks', trackId]);
                continue;
            }

            seenTrackIds.add(trackId);
            if (track.subsonic.albumId) albumsInUse.add(track.subsonic.albumId);
            for (const artist of track.subsonic.artists) {
                artistsInUse.add(artist.id);
            }
        } else if (track) {
            logger.warn(`Orphaned track data for ID ${trackId} did not match SongSchema, removing.`);
            await database.delete(['tracks', trackId]);
        }
    }

    // Pass 2: Process albums and collect additional artist references
    for await (const albumEntry of database.list({ prefix: ['albums'] })) {
        const albumId = albumEntry.key[1] as string;

        if (!albumsInUse.has(albumId)) {
            logger.info(`❌ Removing orphaned album: ${albumId}`);
            await database.delete(['albums', albumId]);
            continue;
        }

        const albumParseResult = AlbumSchema.safeParse(albumEntry.value);
        if (albumParseResult.success) {
            const album = albumParseResult.data;
            const originalSongCount = album.subsonic.song.length;

            // Assuming album.subsonic.song contains string IDs as per handleAlbum logic
            album.subsonic.song = album.subsonic.song.filter((trackIdOrObject) => {
                if (typeof trackIdOrObject === 'string') {
                    return seenTrackIds.has(trackIdOrObject);
                }
                // If it can store SongSchema or SongID3Schema, need to get ID from object
                const id = (trackIdOrObject as Song).subsonic?.id || (trackIdOrObject as { id: string })?.id;
                return id ? seenTrackIds.has(id) : false;
            });

            if (album.subsonic.song.length !== originalSongCount) {
                await database.set(albumEntry.key, album);
            }

            for (const artist of album.subsonic.artists) {
                artistsInUse.add(artist.id);
            }
        } else {
            logger.warn(`Data for album ID ${albumId} did not match AlbumSchema, skipping cleanup for this entry.`);
        }
    }

    // Pass 3: Remove orphaned artists
    for await (const artistEntry of database.list({ prefix: ['artists'] })) {
        const artistId = artistEntry.key[1] as string;

        if (!artistsInUse.has(artistId)) {
            logger.info(`❌ Removing orphaned artist: ${artistId}`);
            await database.delete(['artists', artistId]);
        }
    }

    // Pass 4: Cleanup user data & playlists
    for await (const userDataEntry of database.list({ prefix: ['userData'] })) {
        const key = userDataEntry.key; // e.g. ['userData', username, entityType, entityId]
        if (key.length === 4) {
            const entityType = key[2] as string; // 'track', 'album', 'artist'
            const entityId = key[3] as string;

            // Ensure userData value conforms to schema if needed for further processing,
            // but for deletion, just checking ID existence is enough.
            // const userDataParse = userDataSchema.safeParse(userDataEntry.value);
            // if (!userDataParse.success) {
            //     logger.warn(`Malformed userData for ${entityType} ${entityId}, user ${key[1]}. Deleting.`);
            //     await database.delete(userDataEntry.key);
            //     continue;
            // }

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
        const playlistParseResult = PlaylistSchema.safeParse(playlistEntry.value); // Playlist is the type, PlaylistSchema is the schema
        if (playlistParseResult.success) {
            const playlist = playlistParseResult.data;
            const originalLength = playlist.entry.length;
            // Assuming playlist.entry contains string IDs
            playlist.entry = playlist.entry.filter((trackIdOrObject) => {
                if (typeof trackIdOrObject === 'string') {
                    return seenTrackIds.has(trackIdOrObject);
                }
                // If it can store SongID3Schema objects
                const id = (trackIdOrObject as { id: string })?.id;
                return id ? seenTrackIds.has(id) : false;
            });

            if (playlist.entry.length !== originalLength) {
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
}

async function scanDirectory(dir: string) {
    // First pass to count applicable files for progress, simpler extensions
    for await (const _entry of walk(dir, { exts: ['.flac', '.mp3', '.wav', '.ogg', '.m4a'] })) {
        scanStatus.totalFiles++;
    }

    // Second pass to process files, case-insensitive extensions
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
    if (!metadata) return; // extractMetadata now returns parsed SongSchema or null

    // metadata is already SongSchema.parse output from extractMetadata
    logger.info(`📀 Updating metadata for ${filePath}`);
    await database.set(['tracks', trackId], metadata);
}

export async function getArtistIDByName(name: string): Promise<string | undefined> {
    for await (const entry of database.list({ prefix: ['artists'] })) {
        // entry.value should conform to ArtistSchema
        const artistParseResult = ArtistSchema.safeParse(entry.value); // Artist is the type, ArtistSchema is the schema
        if (artistParseResult.success) {
            const artistData = artistParseResult.data;
            // artistData.artist is ArtistID3Schema
            if (artistData.artist.name.toLowerCase().trim() === name.toLowerCase().trim()) {
                return artistData.artist.id;
            }
        }
    }
    return undefined;
}

async function getAlbumIDByName(name: string, artists?: AlbumID3Artists[]): Promise<string | undefined> {
    const albums = database.list({ prefix: ['albums'] });

    for await (const { value } of albums) {
        const parsedEntry = AlbumSchema.safeParse(value); // AlbumSchema is correct
        if (!parsedEntry.success) continue;

        const { subsonic } = parsedEntry.data; // Corrected syntax
        if (subsonic.name.toLowerCase().trim() !== name.toLowerCase().trim()) continue;

        if (
            !artists?.length || // artists is AlbumID3Artists[]
            subsonic.artists.some((albumArtist) =>
                // albumArtist is AlbumID3Artists
                artists.some((a) => a.name.toLowerCase().trim() === albumArtist.name.toLowerCase().trim())
            )
        ) {
            return subsonic.id;
        }
    }

    return undefined;
}

async function handleCoverArt(id: string, pictures?: IPicture[], trackPath?: string, url?: string) {
    const coverEntry = await database.get(['covers', id]);
    const coverArtParseResult = CoverArtSchema.safeParse(coverEntry.value); // CoverArt is the type, CoverArtSchema is the schema
    const coverExists = coverArtParseResult.success ? coverArtParseResult.data : null;

    if ((coverExists && await exists(coverExists.path)) || (!pictures?.length && !trackPath && !url)) return;

    const coversDir = path.join(config.data_folder, 'covers');
    const mimeToExt: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
    };

    let newCoverArt: CoverArt | undefined;

    if (url) {
        try {
            const response = await fetch(url);
            if (!response.ok) return;
            const contentType = response.headers.get('content-type') || '';
            const ext = mimeToExt[contentType.toLowerCase()] || 'jpg'; // Ensure contentType is lowercased
            const filePath = path.join(coversDir, `${id}.${ext}`);

            const coversDirExists = await exists(coversDir);
            if (!coversDirExists) await Deno.mkdir(coversDir, { recursive: true });
            const imageData = new Uint8Array(await response.arrayBuffer());
            await Deno.writeFile(filePath, imageData);

            newCoverArt = { id, mimeType: contentType, path: filePath };
            // deno-lint-ignore no-explicit-any
        } catch (e: any) {
            logger.error(`Error downloading image for ${id} from ${url}: ${e.message}`);
        }
    } else if (trackPath) {
        const dir = path.dirname(trackPath);
        const coverNames = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.png', 'album.jpg', 'front.jpg', 'front.png']; // Added more common names

        for (const name of coverNames) {
            const coverPath = path.join(dir, name);
            if (await exists(coverPath)) {
                newCoverArt = {
                    id,
                    mimeType: `image/${path.extname(coverPath).substring(1).toLowerCase()}`,
                    path: coverPath,
                };
                break;
            }
        }
    } else if (pictures && pictures.length > 0) {
        // Prefer 'Cover (front)' then any other cover type
        const cover = pictures.find((pic) => pic.type?.toLowerCase().includes('cover (front)')) ||
            pictures.find((pic) => pic.type?.toLowerCase().startsWith('cover'));
        if (cover) {
            const coversDirExists = await exists(coversDir);
            if (!coversDirExists) await Deno.mkdir(coversDir, { recursive: true });
            const ext = mimeToExt[cover.format.toLowerCase()] || 'jpg'; // Ensure format is lowercased
            const filePath = path.join(coversDir, `${id}.${ext}`);
            await Deno.writeFile(filePath, cover.data);
            newCoverArt = { id, mimeType: cover.format, path: filePath };
        }
    }

    if (newCoverArt) {
        const validatedCoverArt = CoverArtSchema.safeParse(newCoverArt); // CoverArt is the type
        if (validatedCoverArt.success) {
            await database.set(['covers', id], validatedCoverArt.data);
        } else {
            logger.error(`Failed to validate new cover art for ID ${id}: ${validatedCoverArt.error.issues}`);
        }
    }
}

async function handleAlbum(albumId: string, trackId: string, albumArtists: AlbumID3Artists[], metadata: IAudioMetadata) {
    const albumEntry = await database.get(['albums', albumId]);
    const existingAlbumParse = AlbumSchema.safeParse(albumEntry.value);
    const existingAlbum = existingAlbumParse.success ? existingAlbumParse.data : null;

    if (existingAlbum) {
        let changes = false;
        // Ensure song list contains unique string IDs
        const songSet = new Set(
            existingAlbum.subsonic.song.map((s) => typeof s === 'string' ? s : (s as Song).subsonic.id || (s as { id: string }).id).filter(Boolean),
        );

        if (!songSet.has(trackId)) {
            existingAlbum.subsonic.song.push(trackId); // Push string ID
            existingAlbum.subsonic.songCount = existingAlbum.subsonic.song.length; // Recalculate based on array length
            existingAlbum.subsonic.duration = Math.round(existingAlbum.subsonic.duration + (metadata.format.duration || 0));
            changes = true;
        }

        if (!existingAlbum.subsonic.discTitles.find((disc) => disc.disc === (metadata.common.disk.no || 1))) { // Default disc 1
            existingAlbum.subsonic.discTitles.push({ disc: metadata.common.disk.no || 1, title: `Disc ${metadata.common.disk.no || 1}` });
            changes = true;
        }

        // Update artists on album if new artists found (less common for existing album, but possible)
        for (const newArtist of albumArtists) {
            if (!existingAlbum.subsonic.artists.some((a) => a.id === newArtist.id)) {
                existingAlbum.subsonic.artists.push(newArtist);
                changes = true;
            }
        }
        // Update artist's album list
        for (const currentAlbumArtist of existingAlbum.subsonic.artists) { // Iterate existing artists on album
            const artistEntry = await database.get(['artists', currentAlbumArtist.id]);
            const artistParse = ArtistSchema.safeParse(artistEntry.value);
            if (artistParse.success) {
                const artist = artistParse.data;
                if (!artist.artist.album.includes(albumId)) {
                    artist.artist.album.push(albumId);
                    artist.artist.albumCount = artist.artist.album.length; // Recalculate
                    await database.set(['artists', artist.artist.id], artist);
                    // No 'changes = true' here as this is an artist update, not album
                }
            }
        }

        if (changes) {
            // Ensure subsonic.displayArtist is updated if artists changed
            existingAlbum.subsonic.displayArtist = existingAlbum.subsonic.artists.length > 1
                ? existingAlbum.subsonic.artists.slice(0, -1).map((a) => a.name).join(', ') + ' & ' +
                    existingAlbum.subsonic.artists[existingAlbum.subsonic.artists.length - 1].name
                : existingAlbum.subsonic.artists[0]?.name || '';

            const validatedAlbum = AlbumSchema.safeParse(existingAlbum);
            if (validatedAlbum.success) {
                await database.set(['albums', albumId], validatedAlbum.data);
            } else {
                logger.error(`Error validating existing album ${albumId} before save: ${validatedAlbum.error.issues}`);
            }
        }
        return;
    }

    // Create new album
    for (const anArtist of albumArtists) { // anArtist is AlbumID3Artists
        const artistEntry = await database.get(['artists', anArtist.id]);
        const artistParse = ArtistSchema.safeParse(artistEntry.value);
        if (artistParse.success) {
            const artist = artistParse.data;
            if (!artist.artist.album.includes(albumId)) {
                artist.artist.album.push(albumId);
                artist.artist.albumCount = (artist.artist.albumCount || 0) + 1;
                await database.set(['artists', artist.artist.id], artist);
            }
        }
    }

    const [yearStr = '1970', monthStr = '1', dayStr = '1'] = (metadata.common.date || metadata.common.originalyear?.toString() || '1970-1-1').split(
        '-',
    );
    const releaseDate = AlbumReleaseDateSchema.safeParse({
        year: parseInt(yearStr),
        month: parseInt(monthStr),
        day: parseInt(dayStr),
    });

    const genres: Genre[] | undefined =
        metadata.common.genre?.flatMap((g: string) =>
            g.split(separatorsToRegex(config.genre_separators)).map((name: string) => ({ name: name.trim() }))
        ).filter((g) => g.name) || undefined;

    const newAlbumData = { // Constructing data for AlbumSchema
        backend: {
            dateAdded: Date.now(),
            lastFM: false,
        },
        // albumInfo will be added later by handleLastFMMetadata
        subsonic: {
            id: albumId,
            name: metadata.common.album || 'Unknown Album',
            artist: albumArtists[0]?.name || 'Unknown Artist', // Primary artist string
            year: metadata.common.year || (releaseDate.success ? releaseDate.data.year : undefined) || undefined,
            coverArt: albumId, // Will point to the cover art ID
            duration: metadata.format.duration ? Math.round(metadata.format.duration) : 0,
            genre: genres?.map((genre: Genre) => genre.name).join(', ') || undefined,
            genres: genres,
            created: (new Date(
                metadata.common.date ||
                    (releaseDate.success ? `${releaseDate.data.year}-${releaseDate.data.month}-${releaseDate.data.day}` : '1970-01-01'),
            )).toISOString(),
            artistId: albumArtists[0]?.id || undefined,
            songCount: 1,
            artists: albumArtists,
            displayArtist: albumArtists.length > 1
                ? albumArtists.slice(0, -1).map((a) => a.name).join(', ') + ' & ' + albumArtists[albumArtists.length - 1].name
                : albumArtists[0]?.name || '',
            releaseTypes: metadata.common.releasetype ? [metadata.common.releasetype.join('/')] : ['album'],
            originalReleaseDate: releaseDate.success ? releaseDate.data : undefined,
            releaseDate: releaseDate.success ? releaseDate.data : undefined,
            song: [trackId], // Array of track IDs
            discTitles: [{
                disc: metadata.common.disk.no || 1, // Default to 1 if not present
                title: `Disc ${metadata.common.disk.no || 1}`,
            }],
            // musicBrainzId, etc., can be populated later or from metadata if available
            musicBrainzId: metadata.common.musicbrainz_albumid || undefined,
        },
    };

    const albumParseResult = AlbumSchema.safeParse(newAlbumData);
    if (albumParseResult.success) {
        await database.set(['albums', albumId], albumParseResult.data);
    } else {
        logger.error(`Failed to validate new album ${albumId}: ${albumParseResult.error.issues}`);
        console.error('Problematic album data:', newAlbumData);
    }
}

async function handleArtist(artistString: string): Promise<AlbumID3Artists[]> { // Returns AlbumID3Artists[]
    const unsortedNames = artistString.split(separatorsToRegex(config.artist_separators));
    const sortedArtists: AlbumID3Artists[] = [];

    for (const name of unsortedNames) {
        const trimmedName = name.trim();
        if (!trimmedName) continue;

        let id = await getArtistIDByName(trimmedName);
        let artistData: Artist | null = null; // Artist is the type

        if (id) {
            const artistEntry = await database.get(['artists', id]);
            const parseResult = ArtistSchema.safeParse(artistEntry.value);
            if (parseResult.success) artistData = parseResult.data;
        }

        if (!artistData) { // If artistData is null (not found or failed parse)
            id = await generateId();
            const newArtistArtistPart = ArtistID3Schema.safeParse({ // ArtistID3Schema for the 'artist' field
                id,
                name: trimmedName,
                albumCount: 0,
                album: [],
            });

            if (newArtistArtistPart.success) {
                const newArtistFull = ArtistSchema.safeParse({ // ArtistSchema for the full artist object
                    artist: newArtistArtistPart.data,
                    lastFM: false,
                });
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

        if (artistData) { // Add to sortedArtists if successfully created/found
            sortedArtists.push({ id: artistData.artist.id, name: artistData.artist.name });
        }
    }
    return sortedArtists;
}

async function handleLastFMMetadata() {
    const connectedToInternet = await checkInternetConnection();

    if (connectedToInternet && config.last_fm?.enabled && config.last_fm.api_key) {
        for await (const albumEntry of database.list({ prefix: ['albums'] })) {
            const albumParseResult = AlbumSchema.safeParse(albumEntry.value);
            if (!albumParseResult.success) {
                logger.warn(`Skipping Last.fm metadata for malformed album: ${String(albumEntry.key[1])}`);
                continue;
            }
            const album = albumParseResult.data;

            if (album.backend.lastFM || album.albumInfo) continue; // Already processed

            const primaryArtistName = album.subsonic.artists[0]?.name || album.subsonic.artist; // Use array first, fallback to string
            if (!primaryArtistName) {
                logger.warn(`Skipping Last.fm metadata for album "${album.subsonic.name}" due to missing primary artist name.`);
                continue;
            }

            const info = await getAlbumInfo(album.subsonic.name, primaryArtistName);

            if (info && info.album) {
                const albumInfoParse = AlbumInfoSchema.safeParse({ // Validate with AlbumInfoSchema
                    notes: info.album?.wiki?.content || info.album?.wiki?.summary || '', // Prefer content over summary if available
                    musicBrainzId: info.album?.mbid || album.subsonic.musicBrainzId, // Keep existing if LastFM doesn't provide
                    lastFmUrl: info.album?.url,
                    smallImageUrl: info.album?.image?.find((i: Record<string, string>) => i.size === 'small')?.['#text'],
                    mediumImageUrl: info.album?.image?.find((i: Record<string, string>) => i.size === 'medium')?.['#text'],
                    largeImageUrl: info.album?.image?.find((i: Record<string, string>) => i.size === 'extralarge' || i.size === 'large')?.['#text'], // Prefer extralarge
                });

                if (albumInfoParse.success) {
                    album.albumInfo = albumInfoParse.data;
                    // Update subsonic album's musicBrainzId if new one found from LastFM
                    if (album.albumInfo.musicBrainzId && !album.subsonic.musicBrainzId) {
                        album.subsonic.musicBrainzId = album.albumInfo.musicBrainzId;
                    }
                } else {
                    logger.warn(`Failed to parse Last.fm album info for "${album.subsonic.name}": ${albumInfoParse.error.issues}`);
                }

                if (album.albumInfo && (album.albumInfo.largeImageUrl || album.albumInfo.mediumImageUrl || album.albumInfo.smallImageUrl)) {
                    await handleCoverArt(
                        album.subsonic.id,
                        undefined,
                        undefined,
                        album.albumInfo.largeImageUrl || album.albumInfo.mediumImageUrl || album.albumInfo.smallImageUrl,
                    );
                }
            }
            album.backend.lastFM = true; // Mark as processed
            logger.debug(`📝 Updating LastFM metadata for album: ${album.subsonic.name}`);
            await database.set(['albums', album.subsonic.id], album); // Save updated album
        }

        for await (const artistEntry of database.list({ prefix: ['artists'] })) {
            const artistParseResult = ArtistSchema.safeParse(artistEntry.value);
            if (!artistParseResult.success) {
                logger.warn(`Skipping Last.fm metadata for malformed artist: ${String(artistEntry.key[1])}`);
                continue;
            }
            const artist = artistParseResult.data;

            if (artist.lastFM || artist.artistInfo) continue;

            const artistInfoFromAPI = await getArtistInfo(artist.artist.name);
            if (artistInfoFromAPI && artistInfoFromAPI.artist) {
                const similarArtistNames: string[] = [];
                if (artistInfoFromAPI.artist.similar && artistInfoFromAPI.artist.similar.artist?.length) {
                    for (const simArt of artistInfoFromAPI.artist.similar.artist) {
                        if (simArt.name) similarArtistNames.push(simArt.name);
                    }
                }

                let imageURLsFromSpotify: { size: string; url: string }[] = [];
                if (config.spotify?.enabled && config.spotify.client_id && config.spotify.client_secret) {
                    // Assuming getArtistCover returns an array of {size: string, url: string} or similar
                    const spotifyCovers = await getArtistCover(artist.artist.name, database, config.spotify.client_id, config.spotify.client_secret);
                    if (Array.isArray(spotifyCovers)) imageURLsFromSpotify = spotifyCovers;
                }

                const getImage = (size: 'small' | 'medium' | 'large' | 'extralarge') => {
                    const spotifyImg = imageURLsFromSpotify.find((i) => i.size === size)?.url;
                    if (spotifyImg) return spotifyImg;
                    return artistInfoFromAPI.artist?.image?.find((i: Record<string, string>) => i.size === size)?.['#text'];
                };

                const artistInfoData = ArtistInfoSchema.safeParse({
                    id: artist.artist.id, // This should be the local ID, not from LastFM
                    biography: artistInfoFromAPI.artist.bio?.content || artistInfoFromAPI.artist.bio?.summary || '',
                    musicBrainzId: artistInfoFromAPI.artist.mbid || artist.artist.musicBrainzId,
                    lastFmUrl: artistInfoFromAPI.artist.url,
                    smallImageUrl: getImage('small'),
                    mediumImageUrl: getImage('medium'),
                    largeImageUrl: getImage('extralarge') || getImage('large'), // Prefer extralarge
                    similarArtist: similarArtistNames,
                });

                if (artistInfoData.success) {
                    artist.artistInfo = artistInfoData.data;
                    const coverArtUrl = artist.artistInfo.largeImageUrl || artist.artistInfo.mediumImageUrl || artist.artistInfo.smallImageUrl;
                    if (coverArtUrl) await handleCoverArt(artist.artist.id, undefined, undefined, coverArtUrl);

                    // Update main artist record
                    if (artist.artistInfo.musicBrainzId && !artist.artist.musicBrainzId) {
                        artist.artist.musicBrainzId = artist.artistInfo.musicBrainzId;
                    }
                    artist.artist.artistImageUrl = coverArtUrl || artist.artist.artistImageUrl;
                    if (coverArtUrl) artist.artist.coverArt = artist.artist.id; // Link coverArt if image found
                } else {
                    logger.warn(`Failed to parse Last.fm artist info for "${artist.artist.name}": ${artistInfoData.error.issues}`);
                }
            }
            artist.lastFM = true; // Mark as processed
            logger.debug(`📝 Updating LastFM metadata for artist: ${artist.artist.name}`);
            await database.set(['artists', artist.artist.id], artist); // Save updated artist
        }
    }
}

async function extractMetadata(filePath: string, trackId: string): Promise<Song | undefined> { // Return Song or null
    try {
        const stat = await Deno.stat(filePath);
        const lastModified = stat.mtime?.getTime() ?? Date.now();

        const existingEntry = await database.get(['tracks', trackId]);
        if (existingEntry.value) {
            const existingSong = SongSchema.safeParse(existingEntry.value);
            if (existingSong.success && existingSong.data.backend.lastModified === lastModified) {
                // logger.debug(`Skipping ${filePath}, unchanged.`);
                return; // Return existing if unchanged and valid
            }
        }

        logger.info(`🔍 Extracting metadata for ${filePath}`);
        const metadata = await parseFile(filePath, { duration: true, skipCovers: false }); // ensure duration, get covers

        const artists = await handleArtist(metadata.common.artist || 'Unknown Artist');
        const albumArtists = metadata.common.albumartist ? await handleArtist(metadata.common.albumartist) : artists; // Use track artists if no albumartist

        const albumName = metadata.common.album || 'Unknown Album';
        const albumId = await getAlbumIDByName(albumName, albumArtists) || await generateId();
        await handleAlbum(albumId, trackId, albumArtists, metadata);

        await handleCoverArt(albumId, metadata.common.picture, filePath); // Album cover is used for track

        const genres: Genre[] | undefined = metadata.common.genre?.flatMap((g: string) =>
            g.split(separatorsToRegex(config.genre_separators)).map((name: string) => ({ name: name.trim() }))
        ).filter((g) =>
            g.name && g.name.length > 0
        ) || undefined;

        const replayGainParsed = ReplayGainSchema.safeParse({
            trackGain: metadata.common.replaygain_track_gain?.dB,
            trackPeak: metadata.common.replaygain_track_peak?.dB, // music-metadata uses float for peak
            albumGain: metadata.common.replaygain_album_gain?.dB,
            albumPeak: metadata.common.replaygain_album_peak?.dB,
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
                if (lyricItem.syncText?.length) { // Synced
                    const lines = lyricItem.syncText.map((line) => ({ start: line.timestamp, value: line.text }));
                    const parsed = StructuredLyricsSchema.safeParse({
                        displayArtist: artists[0]?.name || 'Unknown Artist',
                        displayTitle: metadata.common.title || path.parse(filePath).name,
                        synced: true,
                        line: lines,
                        // lang can be added if available from metadata.common.language
                    });
                    if (parsed.success) lyricsArray.push(parsed.data);
                } else if (lyricItem.text) { // Unsynced
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

        const songData = { // Data for SongSchema
            backend: {
                lastModified: lastModified,
                lastFM: false, // Default, scrobbling handles actual LastFM status for tracks
                lyrics: lyricsArray,
            },
            subsonic: {
                id: trackId,
                title: metadata.common.title || path.parse(filePath).name,
                album: albumName,
                artist: artists[0]?.name || 'Unknown Artist', // Primary artist string
                track: metadata.common.track.no || undefined, // Zod schema has track as optional number
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
                isVideo: false, // Explicitly false
                discNumber: metadata.common.disk.no || 1, // Default to 1
                created: new Date(stat.birthtime || stat.mtime || Date.now()).toISOString(),
                albumId: albumId,
                artistId: artists[0]?.id || undefined,
                type: 'music', // As per Subsonic examples
                musicBrainzId: metadata.common.musicbrainz_trackid,
                genres: genres,
                artists: artists, // AlbumID3Artists[]
                albumArtists: albumArtists, // AlbumID3Artists[]
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
            console.error('Problematic song data:', songData);
            return;
        }

        // deno-lint-ignore no-explicit-any
    } catch (error: any) {
        logger.error(`❌ Failed to extract metadata for ${filePath}: ${error.message}`);
        // console.error(error); // Optionally log full stack
        return;
    }
}

/**
 * Syncs local "starred" tracks with Last.fm "loved" tracks using timestamps.
 * Incorporates local "unstarred" timestamp for more accurate conflict resolution.
 * @param user The User object containing the backend session key etc.
 * @param lastFMUsername The actual Last.fm username fetched via the session key.
 */
export async function syncUserLovedTracksWithTimestamp(user: User, lastFMUsername: string) {
    // Check necessary config and user session key for *setting* status
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

    // 1. Fetch Remote Loved Tracks Map
    // FIX: Ensure getUserLovedTracksMap is called and assigned to remoteLovedMap
    const remoteLovedMap = await getUserLovedTracksMap(lastFMUsername);
    if (remoteLovedMap === null) {
        logger.error(`Last.fm Timestamp Sync for ${lastFMUsername}: Failed to fetch loved tracks from Last.fm. Aborting sync.`);
        return;
    }

    let pushedLove = 0;
    let pushedUnlove = 0;
    let pulledStar = 0;
    let pulledDateUpdate = 0;
    let skipped = 0;
    let errors = 0;
    const processedRemoteKeys = new Set<string>();

    logger.debug(`Last.fm Timestamp Sync [${lastFMUsername}]: Iterating local userData...`);
    for await (const entry of database.list({ prefix: ['userData', user.backend.id, 'track'] })) {
        const trackId = entry.key[3] as string; // FIX: trackId is used for logging and potentially finding track data
        const userDataParseResult = userDataSchema.safeParse(entry.value);

        if (!userDataParseResult.success) {
            logger.warn(`LFM Sync [${lastFMUsername}]: Malformed userData for track ${trackId}. Skipping.`);
            errors++;
            continue;
        }
        const localUserData = userDataParseResult.data;
        const localStarredDate = localUserData.starred ? new Date(localUserData.starred) : null;
        const localUnstarredDate = localUserData.unstarred ? new Date(localUserData.unstarred) : null;

        let isEffectivelyStarredLocally = false;
        if (localStarredDate) {
            if (!localUnstarredDate || localStarredDate.getTime() >= localUnstarredDate.getTime()) {
                isEffectivelyStarredLocally = true;
            }
        }

        // Get Track Artist/Title
        const trackEntry = await database.get(['tracks', trackId]);
        // FIX: Correct variable name used for parsing track data
        const trackDataParseResult = SongSchema.safeParse(trackEntry.value);
        if (!trackDataParseResult.success) {
            logger.warn(`LFM Sync [${lastFMUsername}]: Track ID ${trackId} (from userData) not found or malformed. Skipping.`);
            errors++;
            continue;
        }
        // FIX: Correct variable name used for accessing track data
        const trackData = trackDataParseResult.data;
        const artistName = trackData.subsonic.artist;
        const trackTitle = trackData.subsonic.title;

        // FIX: Ensure remoteLovedMap is accessible here
        const remoteMapKey = createTrackMapKey(artistName, trackTitle);
        const remoteLoveTimestampUTS = remoteLovedMap.get(remoteMapKey);
        const isLovedRemotely = !!remoteLoveTimestampUTS;
        const remoteLoveTimestampMillis = isLovedRemotely ? remoteLoveTimestampUTS * 1000 : 0;

        if (isLovedRemotely) {
            processedRemoteKeys.add(remoteMapKey);
        }

        try {
            if (isEffectivelyStarredLocally && !isLovedRemotely) {
                // --- A) Local ✅, Remote ❌: Push Love ---
                logger.info(`LFM Sync [${lastFMUsername}]: Loving "${trackTitle}" on Last.fm (Local Starred).`);
                const success = await setTrackLoveStatus(user, artistName, trackTitle, true);
                if (success) pushedLove++;
                else errors++;
            } else if (!isEffectivelyStarredLocally && isLovedRemotely) {
                // --- B) Local ❌, Remote ✅: Check Unstar Date vs Remote Love ---
                if (localUnstarredDate && localUnstarredDate.getTime() > remoteLoveTimestampMillis) {
                    // --- B.1) Local Unstar is NEWER: Push Unlove ---
                    logger.info(`LFM Sync [${lastFMUsername}]: Unloving "${trackTitle}" on Last.fm (Local Unstarred is newer than Remote Love).`);
                    const success = await setTrackLoveStatus(user, artistName, trackTitle, false);
                    if (success) pushedUnlove++;
                    else errors++;
                } else {
                    // --- B.2) Local Unstar Older or Absent: Pull Love to Local Star ---
                    const remoteLoveDate = new Date(remoteLoveTimestampMillis);
                    logger.info(
                        `LFM Sync [${lastFMUsername}]: Starring "${trackTitle}" locally (Loved on Last.fm at ${remoteLoveDate.toISOString()}, no newer local unstar).`,
                    );
                    const updatedUserData = { ...localUserData, starred: remoteLoveDate, unstarred: null };
                    const validationResult = userDataSchema.safeParse(updatedUserData);
                    if (validationResult.success) {
                        await database.set(entry.key, validationResult.data);
                        pulledStar++;
                    } else {
                        errors++;
                        logger.error(
                            `LFM Sync [${lastFMUsername}]: Failed local validation for pulled star on ${trackId}: ${validationResult.error.issues}`,
                        );
                    }
                }
            } else if (isEffectivelyStarredLocally && isLovedRemotely) {
                // --- C) Local ✅, Remote ✅: Compare Timestamps ---
                // FIX: Add null check before calling getTime() on potentially null date
                if (!localStarredDate) {
                    // This case should logically not happen if isEffectivelyStarredLocally is true, but guards against type errors
                    logger.error(
                        `LFM Sync [${lastFMUsername}]: Internal logic error - effectively starred but localStarredDate is null for track ${trackId}`,
                    );
                    errors++;
                    continue; // Skip to next iteration
                }
                const localTimestampMillis = localStarredDate.getTime();
                if (remoteLoveTimestampMillis > localTimestampMillis) {
                    // --- C.1) Remote is Newer: Update Local Star Date ---
                    const remoteLoveDate = new Date(remoteLoveTimestampMillis);
                    logger.info(
                        `LFM Sync [${lastFMUsername}]: Updating local star date for "${trackTitle}" to match newer Last.fm love date (${remoteLoveDate.toISOString()}).`,
                    );
                    const updatedUserData = { ...localUserData, starred: remoteLoveDate, unstarred: null };
                    const validationResult = userDataSchema.safeParse(updatedUserData);
                    if (validationResult.success) {
                        await database.set(entry.key, validationResult.data);
                        pulledDateUpdate++;
                    } else {
                        errors++;
                        logger.error(
                            `LFM Sync [${lastFMUsername}]: Failed local validation updating star date on ${trackId}: ${validationResult.error.issues}`,
                        );
                    }
                } else {
                    // C.2) Local is Newer or Same: States match, do nothing.
                    skipped++;
                }
            } else { // !isEffectivelyStarredLocally && !isLovedRemotely
                // --- D) Local ❌, Remote ❌: States match, do nothing ---
                skipped++;
            }
            // deno-lint-ignore no-explicit-any
        } catch (syncError: any) { // FIX: Use the error variable
            logger.error(`LFM Sync [${lastFMUsername}]: Error during sync logic for track "${trackTitle}" (${trackId}): ${syncError.message}`);
            errors++;
        }
    }

    logger.debug(`Last.fm Timestamp Sync [${lastFMUsername}]: Checking remote loves not found in local processed data...`);
    for (const [remoteKey, remoteLoveTimestampUTS] of remoteLovedMap.entries()) {
        if (!processedRemoteKeys.has(remoteKey)) {
            const localTrackId = null; // Simulate for now
            const [artistLower, titleLower] = remoteKey.split('||');

            if (localTrackId) {
                const userDataKey: Deno.KvKey = ['userData', lastFMUsername, 'track', localTrackId];
                const userDataEntry = await database.get(userDataKey);
                const existingUserData = userDataSchema.safeParse(userDataEntry.value).success
                    ? userDataSchema.parse(userDataEntry.value)
                    : { id: localTrackId };
                const localStarredDate = existingUserData.starred ? new Date(existingUserData.starred) : null;
                const localUnstarredDate = existingUserData.unstarred ? new Date(existingUserData.unstarred) : null;
                let isEffectivelyStarredLocally = false;
                if (localStarredDate && (!localUnstarredDate || localStarredDate.getTime() >= localUnstarredDate.getTime())) {
                    isEffectivelyStarredLocally = true;
                }

                if (!isEffectivelyStarredLocally) {
                    const remoteLoveDate = new Date(remoteLoveTimestampUTS * 1000);
                    logger.info(`LFM Sync [${lastFMUsername}]: Starring "${titleLower}" locally (Found remote love, no effective local star).`);
                    const updatedUserData = { ...existingUserData, starred: remoteLoveDate, unstarred: null };
                    const validationResult = userDataSchema.safeParse(updatedUserData);
                    if (validationResult.success) {
                        await database.set(userDataKey, validationResult.data);
                        pulledStar++;
                    } else errors++; /* log error */
                } else {
                    skipped++;
                }
            } else {
                logger.debug(
                    `LFM Sync [${lastFMUsername}]: Track loved remotely ("${artistLower} - ${titleLower}") not found locally. Cannot sync state.`,
                );
                skipped++;
            }
        }
    }

    // --- (Final Summary Log - updated counters) ---
    logger.info(
        `🔄 Finished Timestamp Last.fm sync for ${lastFMUsername}. Love Sent: ${pushedLove}, Unlove Sent: ${pushedUnlove}, Star Pulled: ${pulledStar}, Date Updated: ${pulledDateUpdate}, Skipped: ${skipped}, Errors: ${errors}.`,
    );
}

export async function syncAllConfiguredUsersFavoritesToLastFM() {
    if (!config.last_fm?.enable_scrobbling) {
        logger.info('Last.fm All Users Favorites Sync: Disabled globally (enable_scrobbling is false).');
        return;
    }
    logger.info('Starting Last.fm favorites sync for all configured users (using Timestamps)...');

    let usersFound = 0;
    const userPrefix = ['users'];
    logger.debug(`Looking for users under prefix: ${userPrefix.join('/')}`);

    for await (const entry of database.list({ prefix: userPrefix })) {
        const userParseResult = UserSchema.safeParse(entry.value);
        if (userParseResult.success) {
            const user = userParseResult.data;
            usersFound++;

            if (user.backend?.lastFMSessionKey && config.last_fm.api_key && config.last_fm.api_secret) {
                logger.debug(`User ${user.subsonic?.username || user.backend.id} has Last.fm session key. Attempting to fetch username...`);
                const fetchedUsername = await getUsernameFromSessionKey(user.backend.lastFMSessionKey);

                if (fetchedUsername) {
                    await syncUserLovedTracksWithTimestamp(user, fetchedUsername);
                } else {
                    logger.warn(
                        `Could not fetch Last.fm username for user ${
                            user.subsonic?.username || user.backend.id
                        } using their session key. Skipping sync.`,
                    );
                }
            } else {
                logger.debug(
                    `Skipping Last.fm sync for user ${user.subsonic?.username || user.backend.id}: Missing session key, or global API key/secret.`,
                );
            }
        } else {
            logger.warn(`Data at key ${entry.key.join('/')} did not match User schema.`);
        }
    }

    if (usersFound === 0) {
        logger.warn(`Last.fm All Users Favorites Sync: No user entries found under prefix ${userPrefix.join('/')}.`);
    }
    logger.info('Finished Last.fm favorites sync cycle for all users.');
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
