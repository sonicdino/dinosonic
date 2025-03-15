// Here houses the recursive file scanner and metadata scanner.
import { walk } from 'walk';
import { IAudioMetadata, IPicture, parseFile } from 'music-metadata';
import * as path from 'path';
import { config, database, exists, logger, separatorsToRegex } from './util.ts';
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
    ReplayGainSchema,
    Song,
    SongSchema,
    StructuredLyricsSchema,
} from './zod.ts';
import { Genre } from './zod.ts';
import { getAlbumInfo, getArtistInfo } from './LastFM.ts';

const seenFiles = new Set<string>();
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

    for await (const entry of database.list({ prefix: ['filePathToId'] })) {
        const filePath = entry.key[1] as string;
        if (!seenFiles.has(filePath)) {
            const trackId = entry.value as string;
            await database.delete(['tracks', trackId]);
            await database.delete(entry.key);
            logger.info(`❌ Removed: ${trackId}`);
        }
    }

    scanStatus.scanning = false;
    logger.info('✅ Media scan complete.');
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

    // Move existence check inside extractMetadata
    const metadata = await extractMetadata(filePath, trackId, database);
    if (!metadata) return;

    logger.info(`📀 Updating metadata for ${filePath}`);
    await database.set(['tracks', trackId], metadata);
}

async function getNextId(database: Deno.Kv, type: 't' | 'a' | 'A' | 'c'): Promise<string> {
    const idKey = ['counters', type];
    const lastId = (await database.get(idKey)).value as number || 0;
    const newId = lastId + 1;
    await database.set(idKey, newId);
    return `${type}${newId}`;
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
        const coverNames = ['cover.jpg', 'folder.jpg', 'album.png', 'album.jpg'];

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
                await database.set(['artists', albumArtists[0].id], artist);
                changes = true;
            }
        }

        if (!exists.albumInfo && config.last_fm && config.last_fm.enabled && config.last_fm.api_key) {
            const info = await getAlbumInfo(metadata.common.album || '', albumArtists[0].name, config.last_fm.api_key);

            if (info) {
                changes = true;
                albumInfo = AlbumInfoSchema.parse({
                    notes: info.album?.wiki?.summary || '',
                    musicBrainzId: info.album?.mbid,
                    lastFmUrl: info.album?.url,
                    smallImageUrl: info.album?.image.find((i: Record<string, string>) => i.size === 'small')?.['#text'],
                    mediumImageUrl: info.album?.image.find((i: Record<string, string>) => i.size === 'medium')?.['#text'],
                    largeImageUrl: info.album?.image.find((i: Record<string, string>) => i.size === 'large')?.['#text'],
                });
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
            await database.set(['artists', albumArtists[0].id], artist);
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
        year: metadata.common.year,
        coverArt: albumId,
        duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
        genre: genres?.map((genre: Genre) => genre.name).join(', '),
        genres: genres,
        created: (new Date(metadata.common.date || '1970-1-1')).toISOString(),
        artistId: albumArtists[0].id,
        songCount: 1,
        recordLabels: [{ name: 'TODO: Add support for record labels' }],
        musicBrainzId: undefined,
        artists: albumArtists,
        displayArtist: albumArtists.map((artist) => artist.name).join(', '),
        releaseTypes: ['album'],
        originalReleaseDate,
        releaseDate: originalReleaseDate,
        song: [trackId],
        // TODO: Disc titles.
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
        albumInfo,
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

        if (!artistExists || (!artistExists.artistInfo?.id && config.last_fm?.api_key)) {
            // TODO: Logging
            let artistInfo;

            if (config.last_fm?.api_key) {
                const ArtistInfo = await getArtistInfo(name, config.last_fm.api_key);
                artistInfo = ArtistInfoSchema.parse({
                    id,
                    biography: ArtistInfo?.artist?.bio?.summary || '',
                    musicBrainzId: ArtistInfo.artist?.mbid,
                    lastFmUrl: ArtistInfo.artist?.url,
                    smallImageUrl: ArtistInfo.artist?.image.find((i: Record<string, string>) => i.size === 'small')?.['#text'],
                    mediumImageUrl: ArtistInfo.artist?.image.find((i: Record<string, string>) => i.size === 'medium')?.['#text'],
                    largeImageUrl: ArtistInfo.artist?.image.find((i: Record<string, string>) => i.size === 'large')?.['#text'],
                });

                if ((artistInfo.largeImageUrl || artistInfo.mediumImageUrl || artistInfo.smallImageUrl)) {
                    await handleCoverArt(
                        database,
                        id,
                        undefined,
                        undefined,
                        artistInfo.largeImageUrl || artistInfo.mediumImageUrl || artistInfo.smallImageUrl,
                    );
                }
            }

            const Artist = ArtistID3Schema.parse({
                id,
                name,
                musicBrainzId: artistInfo ? artistInfo.musicBrainzId : undefined,
                artistImageUrl: artistInfo ? (artistInfo.largeImageUrl || artistInfo.mediumImageUrl || artistInfo.smallImageUrl) : undefined,
                coverArt: artistInfo ? id : undefined,
            });

            await database.set(['artists', id], {
                artistInfo: artistInfo || {},
                artist: Artist,
            });
        }

        sorted.push({ id, name });
    }

    return sorted;
}

async function extractMetadata(filePath: string, trackId: string, database: Deno.Kv) {
    try {
        const existing = await database.get(['tracks', trackId]);
        const lastModified = (await Deno.stat(filePath)).mtime?.getTime() ?? Date.now();

        // If the file hasn't changed, skip processing
        if (existing.value && (existing.value as Song).backend.lastModified === lastModified) return null; // Skip unnecessary parsing
        logger.info(`🔍 Extracting metadata for ${filePath}`);

        const metadata = await parseFile(filePath);

        const album = metadata.common.album || 'Unknown Album';
        const albumId = await getAlbumIDByName(database, album) || await getNextId(database, 'a');

        const coverId = albumId;
        await handleCoverArt(database, coverId, metadata.common.picture, filePath);

        const artists = await handleArtist(database, metadata.common.artist || 'Unknown Artist');
        const albumArtists = await handleArtist(database, metadata.common.albumartist || 'Unknown Artist');
        await handleAlbum(database, albumId, trackId, albumArtists, metadata);

        // await getTrackInfo(database, metadata.common.title || '', artists[0].name, config.last_fm?.api_key);

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
            trackGain: metadata.common.replaygain_track_gain?.dB,
            trackPeak: metadata.common.replaygain_track_peak?.dB,
            albumGain: metadata.common.replaygain_track_gain?.dB,
            albumPeak: metadata.common.replaygain_album_peak?.dB,
        });

        const contentType: Record<string, string> = {
            'flac': 'audio/flac',
            'mp3': 'audio/mpeg',
            'wav': 'aduio/wav',
            'ogg': 'audio/ogg',
        };

        const lyrics = [];
        if (metadata.common.lyrics?.length) {
            const syncedLyrics = metadata.common.lyrics?.find((lyrics) => lyrics.syncText.length)?.syncText.map((line) => {
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
                    line: metadata.common.lyrics?.find((lyrics) => lyrics.syncText.length)?.syncText.map((line) => {
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
                track: metadata.common.track.no,
                year: metadata.common.year,
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
                discNumber: metadata.common.disk.no,
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
