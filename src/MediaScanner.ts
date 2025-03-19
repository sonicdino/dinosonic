// Here houses the recursive file scanner and metadata scanner.
import { walk } from 'walk';
import { IAudioMetadata, IPicture, parseFile } from 'music-metadata';
import * as path from 'path';
import { config, database, exists, getNextId, logger, separatorsToRegex } from './util.ts';
import {
    Album,
    AlbumID3Artists,
    AlbumID3Schema,
    AlbumInfoSchema,
    AlbumReleaseDateSchema,
    AlbumSchema,
    Artist,
    ArtistID3Schema,
    ArtistInfoSchema,
    CoverArt,
    Playlist,
    ReplayGainSchema,
    Song,
    SongSchema,
    StructuredLyricsSchema,
} from './zod.ts';
import { Genre } from './zod.ts';
import { getAlbumInfo, getArtistCover, getArtistInfo } from './LastFM.ts';

const seenFiles = new Set<string>();
const seenTrackIds = new Set<string>();

const PLACEHOLDER_SEPARATORS = [';', '/'];
const separators = PLACEHOLDER_SEPARATORS;

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

export async function scanMediaDirectories(database: Deno.Kv, directories: string[]) {
    if (scanStatus.scanning) {
        logger.warn('Scan already in progress.');
        return scanStatus;
    }

    scanStatus = { scanning: true, count: 0, totalFiles: 0, lastScan: new Date() };

    for (const dir of directories) {
        logger.info(`🔍 Scanning directory: ${dir}`);
        await scanDirectory(database, dir);
    }

    await cleanupTracks();
    await cleanupAlbumAndArtist();
    await handleLastFMMetadata();
    seenFiles.clear();
    scanStatus.scanning = false;
    logger.info('✅ Media scan complete.');
}

// TODO: Possibly optimize cleanup functions
async function cleanupTracks() {
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
        const track = trackEntry.value as Song | undefined;

        if (track) {
            seenTrackIds.add(trackId);
            const filePathEntry = await database.get(['filePathToId', track.subsonic.path]);
            if (!filePathEntry.value) {
                logger.info(`⚠️ Track missing in filePathToId: ${trackId}`);
                await database.delete(['tracks', trackId]);
            }
        }
    }

    for await (const userDataEntry of database.list({ prefix: ['userData'] })) {
        if (userDataEntry.key.length === 4, userDataEntry.key[2] === 'track' && !seenTrackIds.has(userDataEntry.key[3] as string)) {
            logger.info(`❌ Removing user data for missing track: ${userDataEntry.key[3] as string}`);
            await database.delete(userDataEntry.key);
        }
    }

    for await (const playlistEntry of database.list({ prefix: ['playlists'] })) {
        const playlist = playlistEntry.value as Playlist;
        const originalLength = playlist.entry.length;
        playlist.entry = playlist.entry.filter((trackId) => !seenTrackIds.has(trackId as string));

        if (playlist.entry.length !== originalLength) {
            logger.info(`📝 Updated playlist "${playlist.name}", removed missing tracks.`);
            await database.set(['playlists', playlist.id], playlist);
        }
    }
}

async function cleanupAlbumAndArtist() {
    const albumsInUse = new Set<string>();
    const artistsInUse = new Set<string>();

    for await (const trackEntry of database.list({ prefix: ['tracks'] })) {
        const track = trackEntry.value as Song;
        if (track.subsonic.albumId) albumsInUse.add(track.subsonic.albumId);
        for (const artist of track.subsonic.artists) {
            artistsInUse.add(artist.id);
        }
    }

    for await (const albumEntry of database.list({ prefix: ['albums'] })) {
        const albumId = albumEntry.key[1] as string;

        if (!albumsInUse.has(albumId)) {
            logger.info(`❌ Removing orphaned album: ${albumId}`);
            await database.delete(['albums', albumId]);
            continue;
        }

        const album = albumEntry.value as Album;
        const originalSongCount = album.subsonic.song.length;

        // Remove tracks that are not in seenTrackIds
        album.subsonic.song = album.subsonic.song.filter((trackId) => seenTrackIds.has(trackId as string));

        // Only update the database if changes were made
        if (album.subsonic.song.length !== originalSongCount) {
            await database.set(albumEntry.key, album);
        }

        for (const artist of album.subsonic.artists) {
            artistsInUse.add(artist.id);
        }
    }

    for await (const artistEntry of database.list({ prefix: ['artists'] })) {
        const artistId = artistEntry.key[1] as string;

        if (!artistsInUse.has(artistId)) {
            logger.info(`❌ Removing orphaned artist: ${artistId}`);
            await database.delete(['artists', artistId]);
        }
    }

    for await (const userDataEntry of database.list({ prefix: ['userData'] })) {
        if (userDataEntry.key.length === 4, userDataEntry.key[2] === 'artist' && !artistsInUse.has(userDataEntry.key[3] as string)) {
            logger.info(`❌ Removing user data for missing artist: ${userDataEntry.key[3] as string}`);
            await database.delete(userDataEntry.key);
        }

        if (userDataEntry.key.length === 4, userDataEntry.key[2] === 'album' && !albumsInUse.has(userDataEntry.key[3] as string)) {
            logger.info(`❌ Removing user data for missing album: ${userDataEntry.key[3] as string}`);
            await database.delete(userDataEntry.key);
        }
    }

    albumsInUse.clear();
    artistsInUse.clear();
    seenTrackIds.clear();
}

async function scanDirectory(database: Deno.Kv, dir: string) {
    for await (const _entry of walk(dir, { exts: ['.flac', '.mp3', '.wav', '.ogg'] })) {
        scanStatus.totalFiles++;
    }

    for await (const entry of walk(dir, { exts: ['.flac', '.mp3', '.wav', '.ogg'] })) {
        const filePath = entry.path;
        seenFiles.add(filePath);
        await processMediaFile(database, entry.path);
        scanStatus.count++;
    }
}

async function processMediaFile(database: Deno.Kv, filePath: string) {
    let trackId = (await database.get(['filePathToId', filePath])).value as string | null;
    if (!trackId) {
        trackId = await getNextId(database, 't');
        await database.set(['filePathToId', filePath], trackId);
    }

    const metadata = await extractMetadata(filePath, trackId, database);
    if (!metadata) return;

    logger.info(`📀 Updating metadata for ${filePath}`);
    await database.set(['tracks', trackId], metadata);
}

export async function getArtistIDByName(database: Deno.Kv, name: string): Promise<string | undefined> {
    for await (const entry of database.list({ prefix: ['artists'] })) {
        const parsedEntry = ArtistID3Schema.safeParse((entry.value as Artist | null)?.artist);
        if (parsedEntry.success) {
            const artist = parsedEntry.data;
            if (artist.name.toLowerCase().trim() === name.toLowerCase().trim()) return artist.id;
        }
    }
}

async function getAlbumIDByName(database: Deno.Kv, name: string): Promise<string | undefined> {
    for await (const entry of database.list({ prefix: ['albums'] })) {
        const parsedEntry = AlbumSchema.safeParse(entry.value);
        if (parsedEntry.success) {
            const album = parsedEntry.data;
            if (album.subsonic.name === name) return album.subsonic.id;
        }
    }
}

async function handleCoverArt(database: Deno.Kv, id: string, pictures?: IPicture[], trackPath?: string, url?: string) {
    const coverExists = (await database.get(['covers', id])).value as CoverArt | null;
    if ((coverExists && await exists(coverExists.path)) || (!pictures?.length && !trackPath && !url)) return;

    const coversDir = path.join(config.data_folder, 'covers');
    const mimeToExt: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp', // webp sucks.
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
    };

    if (url) {
        try {
            const response = await fetch(url);
            if (!response.ok) return;
            const contentType = response.headers.get('content-type') || '';
            const ext = mimeToExt[contentType] || 'jpg';
            const filePath = path.join(coversDir, `${id}.${ext}`);

            const coversDirExists = await exists(coversDir);
            if (!coversDirExists) await Deno.mkdir(coversDir);
            const imageData = new Uint8Array(await response.arrayBuffer());
            await Deno.writeFile(filePath, imageData);

            return database.set(['covers', id], {
                id,
                mimeType: contentType,
                path: filePath,
            });
        } catch (error) {
            console.error('Error downloading image:', error);
        }
    }

    if (trackPath) {
        const dir = path.dirname(trackPath);
        const coverNames = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'album.png', 'album.jpg'];

        for (const name of coverNames) {
            const coverPath = path.join(dir, name);
            if (await exists(coverPath)) {
                return database.set(['covers', id], {
                    id,
                    mimeType: `image/${path.extname(coverPath).substring(1)}`,
                    path: coverPath,
                });
            }
        }
    }

    if (pictures) {
        const cover = pictures.find((pic) => pic.type?.toLowerCase().startsWith('cover'));
        if (!cover) return;
        const coversDirExists = await exists(coversDir);
        const filePath = path.join(coversDir, `${id}.${mimeToExt[cover.format as string]}`);
        if (!coversDirExists) await Deno.mkdir(coversDir);
        await Deno.writeFile(filePath, cover.data);
        return database.set(['covers', id], {
            id,
            mimeType: cover.format,
            path: filePath,
        });
    }
}

async function handleAlbum(database: Deno.Kv, albumId: string, trackId: string, albumArtists: AlbumID3Artists[], metadata: IAudioMetadata) {
    const exists = (await database.get(['albums', albumId])).value as Album | null;
    let albumInfo;
    if (exists) {
        let changes = false;
        if (!exists.subsonic.song.includes(trackId)) {
            exists.subsonic.songCount = exists.subsonic.songCount + 1;
            exists.subsonic.duration = Math.round(exists.subsonic.duration + (metadata.format.duration || 0));
            exists.subsonic.song.push(trackId);
            changes = true;
        }

        if (!exists.subsonic.discTitles.find((disc) => disc.disc === metadata.common.disk.no)) {
            exists.subsonic.discTitles.push({ disc: metadata.common.disk.no || 0, title: `Disc ${metadata.common.disk.no || 0}` });
            changes = true;
        }

        for await (const Artist of albumArtists) {
            const artist = (await database.get(['artists', Artist.id])).value as Artist | null;
            if (artist && !artist.artist.album.includes(albumId)) {
                artist.artist.albumCount = (artist.artist.albumCount || 0) + 1;
                artist.artist.album.push(albumId);
                await database.set(['artists', artist.artist.id], artist);
                changes = true;
            }
        }

        if (changes) return database.set(['albums', albumId], { ...exists, albumInfo });
        else return;
    }

    for await (const Artist of albumArtists) {
        const artist = (await database.get(['artists', Artist.id])).value as Artist | null;
        if (artist && !artist.artist.album.includes(albumId)) {
            artist.artist.albumCount = artist.artist.albumCount + 1;
            artist.artist.album.push(albumId);
            await database.set(['artists', artist.artist.id], artist);
        }
    }

    const [year = '1970', month = '1', day = '1'] = (metadata.common.date || '1970-1-1').split('-');
    const originalReleaseDate = AlbumReleaseDateSchema.parse({
        year: parseInt(year),
        month: parseInt(month),
        day: parseInt(day),
    });
    const genres: Genre[] | undefined = (typeof metadata.common.genre === 'string')
        ? (metadata.common.genre as string).split(separatorsToRegex(separators)).map((genre: string) => {
            return { name: genre || '' };
        })
        : (typeof metadata.common.genre === 'object')
        ? metadata.common.genre.map((genre: string) => {
            return { name: genre || '' };
        })
        : undefined;

    const album = AlbumID3Schema.parse({
        id: albumId,
        name: metadata.common.album || 'Unknown Album',
        artist: albumArtists[0].name,
        year: metadata.common.year || 1970,
        coverArt: albumId,
        duration: metadata.format.duration ? Math.round(metadata.format.duration) : 0,
        genre: genres?.map((genre: Genre) => genre.name).join(', '),
        genres: genres,
        created: (new Date(metadata.common.date || '1970-1-1')).toISOString(),
        artistId: albumArtists[0].id,
        songCount: 1,
        // recordLabels: [{ name: 'TODO: Add support for record labels' }],
        musicBrainzId: undefined,
        artists: albumArtists,
        displayArtist: albumArtists.map((artist) => artist.name).join(', '),
        releaseTypes: ['album'],
        originalReleaseDate,
        releaseDate: originalReleaseDate,
        song: [trackId],
        discTitles: [
            {
                disc: metadata.common.disk.no || 0,
                title: `Disc ${metadata.common.disk.no || 0}`,
            },
        ],
    });

    const Album = AlbumSchema.parse({
        backend: {
            dateAdded: Date.now(),
        },
        subsonic: album,
    });

    return database.set(['albums', albumId], Album);
}

async function handleArtist(database: Deno.Kv, artist: string) {
    const unsorted = artist.split(separatorsToRegex(separators));
    const sorted = [];
    for (const artist of unsorted) {
        const name = artist.trim();
        const id = await getArtistIDByName(database, name) || await getNextId(database, 'A');
        const artistExists = (await database.get(['artists', id])).value as Artist | null;

        if (!artistExists) {
            // TODO: Logging

            const artist = ArtistID3Schema.parse({
                id,
                name,
            });

            await database.set(['artists', id], { artist });
        }

        sorted.push({ id, name });
    }

    return sorted;
}

async function handleLastFMMetadata() {
    if (config.last_fm && config.last_fm.enabled && config.last_fm.api_key) {
        for await (const albumEntry of database.list({ prefix: ['albums'] })) {
            const album = albumEntry.value as Album;
            if (album.backend.lastFM || album.albumInfo) continue;

            if (config.last_fm && config.last_fm.enabled && config.last_fm.api_key) {
                const info = await getAlbumInfo(album.subsonic.name, album.subsonic.artists[0].name, config.last_fm.api_key);

                if (info) {
                    album.albumInfo = AlbumInfoSchema.parse({
                        notes: info.album?.wiki?.summary || '',
                        musicBrainzId: info.album?.mbid,
                        lastFmUrl: info.album?.url,
                        smallImageUrl: info.album?.image.find((i: Record<string, string>) => i.size === 'small')?.['#text'],
                        mediumImageUrl: info.album?.image.find((i: Record<string, string>) => i.size === 'medium')?.['#text'],
                        largeImageUrl: info.album?.image.find((i: Record<string, string>) => i.size === 'large')?.['#text'],
                    });

                    album.backend.lastFM = true;

                    if ((album.albumInfo.largeImageUrl || album.albumInfo.mediumImageUrl || album.albumInfo.smallImageUrl)) {
                        await handleCoverArt(
                            database,
                            album.subsonic.id,
                            undefined,
                            undefined,
                            album.albumInfo.largeImageUrl || album.albumInfo.mediumImageUrl || album.albumInfo.smallImageUrl,
                        );
                    }

                    logger.debug(`📝 Updating LastFM metadata for album: ${album.subsonic.name}`);
                    await database.set(['albums', album.subsonic.id], album);
                }
            }
        }

        for await (const artistEntry of database.list({ prefix: ['artists'] })) {
            const artist = artistEntry.value as Artist;
            if (artist.lastFM || artist.artistInfo) continue;

            const ArtistInfo = await getArtistInfo(artist.artist?.name, config.last_fm.api_key);
            if (ArtistInfo) {
                const similarArtist = [];
                let imageURLs = [];

                if (ArtistInfo.artist?.similar && ArtistInfo.artist.similar?.artist?.length) {
                    for (const artist of ArtistInfo.artist.similar.artist) {
                        const artistId = await getArtistIDByName(database, artist.name);
                        if (artistId) similarArtist.push(artistId);
                    }
                }

                if (config.spotify?.enabled && config.spotify.client_id && config.spotify.client_secret) {
                    imageURLs = await getArtistCover(artist.artist.name, database, config.spotify.client_id, config.spotify.client_secret);
                }

                const getImage = (size: 'small' | 'medium' | 'large') =>
                    imageURLs?.find((i: Record<string, string>) => i.size === size)?.url ||
                    ArtistInfo.artist?.image.find((i: Record<string, string>) => i.size === size)?.['#text'];

                const imageData = {
                    small: getImage('small'),
                    medium: getImage('medium'),
                    large: getImage('large'),
                };

                artist.artistInfo = ArtistInfoSchema.parse({
                    id: artist.artist.id,
                    biography: ArtistInfo.artist?.bio?.summary || '',
                    musicBrainzId: ArtistInfo.artist?.mbid,
                    lastFmUrl: ArtistInfo.artist?.url,
                    smallImageUrl: imageData.small,
                    mediumImageUrl: imageData.medium,
                    largeImageUrl: imageData.large,
                    similarArtist,
                });

                const coverArtUrl = imageData.large || imageData.medium || imageData.small;
                if (coverArtUrl) {
                    await handleCoverArt(database, artist.artist.id, undefined, undefined, coverArtUrl);
                }

                artist.lastFM = true;
                artist.artist.musicBrainzId = artist.artistInfo.musicBrainzId;
                artist.artist.artistImageUrl = artist.artistInfo.largeImageUrl || artist.artistInfo.mediumImageUrl ||
                    artist.artistInfo.smallImageUrl;
                artist.artist.coverArt = artist.artist.id;

                logger.debug(`📝 Updating LastFM metadata for artist: ${artist.artist.name}`);
                await database.set(['artists', artist.artist.id], artist);
            }
        }
    }
}

async function extractMetadata(filePath: string, trackId: string, database: Deno.Kv) {
    try {
        const existing = await database.get(['tracks', trackId]);
        const lastModified = (await Deno.stat(filePath)).mtime?.getTime() ?? Date.now();

        // If the file hasn't changed, skip processing
        if (existing.value && (existing.value as Song).backend.lastModified === lastModified) return null;
        // Skip unnecessary parsing
        logger.info(`🔍 Extracting metadata for ${filePath}`);

        const metadata = await parseFile(filePath);

        const album = metadata.common.album || 'Unknown Album';
        const albumId = await getAlbumIDByName(database, album) || await getNextId(database, 'a');

        const coverId = albumId;
        await handleCoverArt(database, coverId, metadata.common.picture, filePath);

        const artists = await handleArtist(database, metadata.common.artist || 'Unknown Artist');
        const albumArtists = await handleArtist(database, metadata.common.albumartist || 'Unknown Artist');
        await handleAlbum(database, albumId, trackId, albumArtists, metadata);

        const genres: Genre[] | undefined = (typeof metadata.common.genre === 'string')
            ? (metadata.common.genre as string).split(separatorsToRegex(separators)).map((genre: string) => {
                return { name: genre || '' };
            })
            : (typeof metadata.common.genre === 'object')
            ? metadata.common.genre.map((genre: string) => {
                return { name: genre || '' };
            })
            : undefined;

        const replayGain = ReplayGainSchema.parse({
            trackGain: metadata.common.replaygain_track_gain?.dB || undefined,
            trackPeak: metadata.common.replaygain_track_peak?.dB || undefined,
            albumGain: metadata.common.replaygain_track_gain?.dB || undefined,
            albumPeak: metadata.common.replaygain_album_peak?.dB || undefined,
        });

        const contentType: Record<string, string> = {
            'flac': 'audio/flac',
            'mp3': 'audio/mpeg',
            'wav': 'aduio/wav',
            'ogg': 'audio/ogg',
        };

        const lyrics = [];
        if (metadata.common.lyrics?.length) {
            const syncedLyrics = metadata.common.lyrics?.find((lyrics) => lyrics.syncText?.length)?.syncText.map((line) => {
                return { start: line.timestamp, value: line.text };
            });

            const unsyncedLyrics = metadata.common.lyrics?.find((lyrics) => lyrics.syncText)?.syncText.map((line) => {
                return { value: line.text };
            });

            if (syncedLyrics) {
                lyrics.push(StructuredLyricsSchema.parse({
                    displayArtist: artists[0].name,
                    displayTitle: metadata.common.title || 'Unknown Title',
                    lang: 'xxx',
                    synced: true,
                    line: metadata.common.lyrics?.find((lyrics) => lyrics.syncText?.length)?.syncText.map((line) => {
                        return { start: line.timestamp, value: line.text };
                    }),
                }));
            }

            if (unsyncedLyrics) {
                lyrics.push(StructuredLyricsSchema.parse({
                    displayArtist: artists[0].name,
                    displayTitle: metadata.common.title || 'Unknown Title',
                    lang: 'xxx',
                    synced: true,
                    line: metadata.common.lyrics?.find((lyrics) => lyrics.syncText)?.syncText.map((line) => {
                        return { value: line.text };
                    }),
                }));
            }
        }

        const songMetadata = SongSchema.parse({
            backend: {
                lastModified: (await Deno.stat(filePath)).mtime?.getTime() ?? Date.now(),
                lyrics,
            },
            subsonic: {
                id: trackId,
                title: metadata.common.title || 'Unknown Title',
                album: album,
                artist: artists[0].name,
                track: metadata.common.track.no || 0,
                year: metadata.common.year || 1970,
                genre: genres?.map((genre: Genre) => genre.name).join(', '),
                coverArt: albumId, // Cover extraction not handled here
                size: (await Deno.stat(filePath)).size,
                contentType: contentType[(filePath.split('.').pop() || 'mp3').toLowerCase()],
                suffix: (filePath.split('.').pop() || 'mp3').toLowerCase(),
                duration: Math.round(metadata.format.duration || 0),
                bitRate: Math.round((metadata.format.bitrate || 1) / 1000),
                bitDepth: metadata.format.bitsPerSample,
                samplingRate: metadata.format.sampleRate,
                channelCount: metadata.format.numberOfChannels,
                path: filePath,
                isVideo: false,
                discNumber: metadata.common.disk.no || 0,
                created: new Date().toISOString(),
                albumId,
                artistId: artists[0].id,
                type: 'music',
                musicBrainzId: metadata.common.musicbrainz_trackid,
                genres: genres,
                artists,
                albumArtists,
                displayAlbumArtist: artists.map((artist) => artist.name).join(', '),
                replayGain,
            },
        });

        return songMetadata;
    } catch (error) {
        logger.error(`❌ Failed to extract metadata for ${filePath}:`);
        console.error(error);
        return null;
    }
}

export function GetScanStatus() {
    return scanStatus;
}

export function StartScan() {
    scanMediaDirectories(database, config.music_folders);
    return scanStatus;
}
