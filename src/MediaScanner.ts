import { config, database, generateId, logger } from './util.ts';
import { SongSchema } from './zod.ts';
import type { ScanStatus } from './scanner/types.ts';
import { scanAudioFiles } from './scanner/FileScanner.ts';
import { DatabaseRepository } from './scanner/DatabaseRepository.ts';
import { extractAudioMetadata, processExtractedMetadata } from './scanner/MetadataExtractor.ts';
import { storeCoverArt } from './scanner/CoverArtManager.ts';
import { handleAlbum, handleArtists } from './scanner/ArtistAlbumHandler.ts';
import { cleanupDatabase, hardReset as performHardReset } from './scanner/DatabaseCleanup.ts';
import { fetchAlbumMetadata, fetchArtistMetadata, getBestArtistCoverUrl, pruneMetadataCache } from './scanner/ExternalMetadataService.ts';
import { syncAllUsersLovedTracks, syncUserLovedTracksWithTimestamp } from './scanner/LastFMSyncService.ts';

const seenFiles = new Set<string>();
const dbRepo = new DatabaseRepository();

let scanStatus: ScanStatus = {
    scanning: false,
    count: 0,
    totalFiles: 0,
    lastScan: new Date(),
    errors: [],
};

async function processMediaFile(filePath: string): Promise<void> {
    try {
        let trackId = await dbRepo.getTrackIdByPath(filePath);
        if (!trackId) {
            trackId = await generateId();
            await dbRepo.setTrackIdForPath(filePath, trackId);
        }

        const stat = await Deno.stat(filePath);
        const lastModified = stat.mtime?.getTime() ?? Date.now();

        const existingEntry = await database.get(['tracks', trackId]);
        if (existingEntry.value) {
            const existingSong = SongSchema.safeParse(existingEntry.value);
            if (existingSong.success && existingSong.data.backend.lastModified === lastModified) {
                return;
            }
        }

        logger.info(`📀 Processing: ${filePath}`);

        const extracted = await extractAudioMetadata(filePath);
        const artists = await handleArtists(extracted.tags.artist, extracted.tags.artists);
        const albumArtists = extracted.tags.albumArtist ? await handleArtists(extracted.tags.albumArtist) : artists;

        const albumId = await dbRepo.getAlbumIdByName(extracted.tags.album, albumArtists) ||
            await generateId();

        await handleAlbum(albumId, trackId, albumArtists, extracted);
        await storeCoverArt(albumId, {
            embeddedPictures: extracted.embeddedPictures,
            trackPath: filePath,
            albumName: extracted.tags.album,
            artistName: albumArtists[0]?.name || extracted.tags.artist,
            musicBrainzReleaseId: extracted.tags.musicBrainzAlbumId,
        });

        const processed = processExtractedMetadata(extracted, artists, albumArtists);

        const songData = {
            backend: {
                lastModified,
                lastFM: false,
                lyrics: processed.lyrics,
            },
            subsonic: {
                id: trackId,
                title: processed.tags.title,
                album: processed.tags.album,
                artist: artists[0]?.name || 'Unknown Artist',
                track: processed.tags.trackNumber,
                year: processed.tags.year,
                genre: processed.tags.genreString,
                coverArt: albumId,
                size: processed.fileInfo.size,
                contentType: processed.fileInfo.contentType,
                suffix: processed.fileInfo.extension,
                duration: processed.audioInfo.duration,
                bitRate: processed.audioInfo.bitRate,
                bitDepth: processed.audioInfo.bitDepth,
                samplingRate: processed.audioInfo.samplingRate,
                channelCount: processed.audioInfo.channelCount,
                path: filePath,
                isVideo: false,
                discNumber: processed.tags.discNumber,
                created: processed.fileInfo.birthtime.toISOString(),
                albumId,
                artistId: artists[0]?.id,
                type: 'music' as const,
                musicBrainzId: processed.tags.musicBrainzTrackId,
                genres: processed.tags.genres,
                artists,
                albumArtists,
                displayArtist: processed.displayArtist,
                displayAlbumArtist: processed.displayAlbumArtist,
                replayGain: processed.replayGain,
            },
        };

        const songParseResult = SongSchema.safeParse(songData);
        if (songParseResult.success) {
            await database.set(['tracks', trackId], songParseResult.data);
        } else {
            const error = `Failed to validate: ${filePath}`;
            logger.error(error);
            songParseResult.error.issues.forEach((issue) => logger.error(`  ${issue.path.join('.')}: ${issue.message}`));
            scanStatus.errors.push(error);
        }
    } catch (error) {
        const errorMsg = `Error processing ${filePath}: ${error}`;
        logger.error(errorMsg);
        scanStatus.errors.push(errorMsg);
    }
}

async function enrichExternalMetadata() {
    logger.info('🌐 Enriching metadata from external sources');

    let albumsProcessed = 0;
    let artistsProcessed = 0;

    for await (const { id, album } of dbRepo.getAllAlbums()) {
        if (album.backend.lastFM) continue;

        const primaryArtist = album.subsonic.artists[0]?.name || album.subsonic.artist;
        if (!primaryArtist) continue;

        try {
            const metadata = await fetchAlbumMetadata(
                album.subsonic.name,
                primaryArtist,
                album.subsonic.musicBrainzId,
            );

            if (metadata.musicBrainz) {
                album.subsonic.musicBrainzId = metadata.musicBrainz.releaseId;

                if (metadata.musicBrainz.coverArtAvailable) {
                    await storeCoverArt(album.subsonic.id, {
                        albumName: album.subsonic.name,
                        artistName: primaryArtist,
                        musicBrainzReleaseId: metadata.musicBrainz.releaseId,
                    });
                }

                if (metadata.musicBrainz.releaseType) {
                    album.subsonic.releaseTypes = [metadata.musicBrainz.releaseType];
                }

                if (metadata.musicBrainz.label && !album.subsonic.recordLabels?.length) {
                    album.subsonic.recordLabels = [{ name: metadata.musicBrainz.label }];
                }

                logger.debug(
                    `MusicBrainz genres for "${album.subsonic.name}": ${metadata.musicBrainz.genres?.length || 0} genres, current album genre: ${
                        album.subsonic.genre || 'none'
                    }`,
                );
                if (metadata.musicBrainz.genres && metadata.musicBrainz.genres.length > 0 && !album.subsonic.genre) {
                    const genreObjects = metadata.musicBrainz.genres.map((name) => ({ name }));
                    const genreString = metadata.musicBrainz.genres.join(', ');
                    album.subsonic.genres = genreObjects;
                    album.subsonic.genre = genreString;
                }

                if (album.subsonic.genre && album.subsonic.genres) {
                    for (const songId of album.subsonic.song) {
                        const songEntry = await database.get(['tracks', songId as string]);
                        if (songEntry.value) {
                            const song = SongSchema.safeParse(songEntry.value);
                            if (song.success && !song.data.subsonic.genre) {
                                song.data.subsonic.genres = album.subsonic.genres;
                                song.data.subsonic.genre = album.subsonic.genre;
                                await database.set(['tracks', songId as string], song.data);
                                logger.debug(`Applied album genres to track: ${song.data.subsonic.title}`);
                            }
                        }
                    }
                }
            }

            if (metadata.lastFm?.albumInfo) {
                album.albumInfo = {
                    notes: metadata.lastFm.albumInfo.wiki?.summary || '',
                    musicBrainzId: metadata.lastFm.albumInfo.mbid || album.subsonic.musicBrainzId,
                    lastFmUrl: metadata.lastFm.albumInfo.url,
                };
            }

            album.backend.lastFM = true;
            await database.set(['albums', id], album);
            albumsProcessed++;
        } catch (error) {
            logger.error(`Error enriching album ${album.subsonic.name}: ${error}`);
        }
    }

    for await (const { id, artist } of dbRepo.getAllArtists()) {
        if (artist.lastFM) continue;

        try {
            const metadata = await fetchArtistMetadata(
                artist.artist.name,
                artist.artist.musicBrainzId,
            );

            if (metadata.musicBrainz) {
                artist.artist.musicBrainzId = metadata.musicBrainz.artistIds?.[0];
            }

            if (metadata.lastFm?.artistInfo) {
                artist.artistInfo = {
                    id: artist.artist.id,
                    biography: metadata.lastFm.artistInfo.bio?.summary || '',
                    musicBrainzId: metadata.lastFm.artistInfo.mbid || artist.artist.musicBrainzId,
                    lastFmUrl: metadata.lastFm.artistInfo.url,
                    // deno-lint-ignore no-explicit-any
                    similarArtist: metadata.lastFm.artistInfo.similar?.artist?.map((sa: any) => sa.name).filter(Boolean) || [],
                };
            }

            if (metadata.spotify?.artistImages || metadata.lastFm?.artistInfo) {
                const artistCoverUrl = await getBestArtistCoverUrl(
                    artist.artist.name,
                    artist.artist.musicBrainzId,
                );

                if (artistCoverUrl) {
                    await storeCoverArt(artist.artist.id, {
                        artistName: artist.artist.name,
                        externalUrl: artistCoverUrl,
                    });
                }
            }

            artist.lastFM = true;
            await database.set(['artists', id], artist);
            artistsProcessed++;
        } catch (error) {
            logger.error(`Error enriching artist ${artist.artist.name}: ${error}`);
        }
    }

    logger.info(`✅ Enriched ${albumsProcessed} albums, ${artistsProcessed} artists`);
}

export async function scanMediaDirectories(
    directories: string[],
    cleanup: boolean = true,
    debugLog: boolean = false,
): Promise<ScanStatus> {
    if (scanStatus.scanning) {
        logger.warn('Scan already in progress');
        return scanStatus;
    }

    scanStatus = {
        scanning: true,
        count: 0,
        totalFiles: 0,
        lastScan: new Date(),
        errors: [],
    };

    dbRepo.clearCaches();
    seenFiles.clear();

    try {
        for await (const file of scanAudioFiles(directories)) {
            seenFiles.add(file.path);
            scanStatus.totalFiles++;
            await processMediaFile(file.path);
            scanStatus.count++;

            if (scanStatus.count % 100 === 0) {
                logger.info(`Progress: ${scanStatus.count}/${scanStatus.totalFiles}`);
            }
        }

        if (cleanup) {
            await cleanupDatabase(seenFiles);
        }

        await enrichExternalMetadata();
        await syncAllUsersLovedTracks();

        const pruned = pruneMetadataCache();
        if (pruned > 0) {
            logger.debug(`Pruned ${pruned} expired cache entries`);
        }
    } catch (error) {
        logger.error(`Scan error: ${error}`);
        scanStatus.errors.push(`Scan error: ${error}`);
    } finally {
        seenFiles.clear();
        scanStatus.scanning = false;

        const level = debugLog ? 'debug' : 'info';
        logger[level](`✅ Scan complete: ${scanStatus.count}/${scanStatus.totalFiles}, ${scanStatus.errors.length} errors`);
    }

    return scanStatus;
}

export function GetScanStatus(): ScanStatus {
    return { ...scanStatus };
}

export function StartScan(): ScanStatus {
    scanMediaDirectories(config.music_folders).catch((err) => {
        logger.error('Scan error:', err);
        scanStatus.scanning = false;
    });
    return scanStatus;
}

export async function hardReset() {
    await performHardReset();
    dbRepo.clearCaches();
    await scanMediaDirectories(config.music_folders);
}

export async function getArtistIDByName(name: string): Promise<string | undefined> {
    return await dbRepo.getArtistIdByName(name);
}

export { syncUserLovedTracksWithTimestamp };
