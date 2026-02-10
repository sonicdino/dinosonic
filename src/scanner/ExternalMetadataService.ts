import { checkInternetConnection, config, logger } from '../util.ts';
import { getAlbumInfo, getArtistInfo } from '../LastFM.ts';
import { getArtistCover } from '../Spotify.ts';
import * as MusicBrainz from './MusicBrainzService.ts';
import type { ExternalMetadata, RetryOptions } from './types.ts';

interface MetadataCache {
    key: string;
    // deno-lint-ignore no-explicit-any
    data: any;
    fetchedAt: number;
    ttl: number;
}

class MetadataCacheManager {
    private cache = new Map<string, MetadataCache>();
    private readonly DEFAULT_TTL = 86400000;

    // deno-lint-ignore no-explicit-any
    get(key: string): any | null {
        const cached = this.cache.get(key);
        if (!cached) return null;

        if (Date.now() - cached.fetchedAt > cached.ttl) {
            this.cache.delete(key);
            return null;
        }

        return cached.data;
    }

    // deno-lint-ignore no-explicit-any
    set(key: string, data: any, ttl: number = this.DEFAULT_TTL): void {
        this.cache.set(key, {
            key,
            data,
            fetchedAt: Date.now(),
            ttl,
        });
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    getStats(): { size: number; keys: string[] } {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys()),
        };
    }

    pruneExpired(): number {
        const now = Date.now();
        let pruned = 0;

        for (const [key, cached] of this.cache.entries()) {
            if (now - cached.fetchedAt > cached.ttl) {
                this.cache.delete(key);
                pruned++;
            }
        }

        return pruned;
    }
}

const metadataCache = new MetadataCacheManager();

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 10000,
};

async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = DEFAULT_RETRY_OPTIONS): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            if (attempt < options.maxAttempts - 1) {
                const delay = Math.min(
                    options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt),
                    options.maxDelayMs,
                );

                logger.warn(`Attempt ${attempt + 1}/${options.maxAttempts} failed, retrying in ${delay}ms: ${lastError.message}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }

    logger.error(`All ${options.maxAttempts} attempts failed: ${lastError?.message}`);
    return null;
}

export async function fetchAlbumMetadata(albumName: string, artistName: string, existingMusicBrainzId?: string): Promise<ExternalMetadata> {
    const cacheKey = `album:${artistName}:${albumName}`;
    const cached = metadataCache.get(cacheKey);
    if (cached) {
        logger.debug(`Using cached metadata for album: ${albumName}`);
        return cached;
    }

    const metadata: ExternalMetadata = {};

    if (!await checkInternetConnection()) {
        logger.warn('No internet connection, skipping external metadata fetch');
        return metadata;
    }

    if (config.last_fm?.enabled && config.last_fm.api_key) {
        const lfmData = await retryWithBackoff(() => getAlbumInfo(albumName, artistName));

        if (lfmData?.album) {
            metadata.lastFm = { albumInfo: lfmData.album };

            if (!existingMusicBrainzId && lfmData.album.mbid) {
                existingMusicBrainzId = lfmData.album.mbid;
            }
        }
    }

    if (config.musicbrainz?.enabled) {
        if (existingMusicBrainzId) {
            const mbData = await retryWithBackoff(() => MusicBrainz.enrichAlbumMetadata(existingMusicBrainzId));

            if (mbData) {
                metadata.musicBrainz = {
                    releaseId: existingMusicBrainzId,
                    artistIds: mbData.artistIds,
                    coverArtAvailable: mbData.coverArt !== null,
                    genres: mbData.genres,
                    tags: mbData.tags,
                    releaseType: mbData.releaseType,
                    releaseDate: mbData.releaseDate,
                    label: mbData.label,
                    country: mbData.country,
                };
            }
        } else {
            logger.debug(`No MusicBrainz ID for album ${albumName}, attempting search`);
            const mbid = await retryWithBackoff(() => MusicBrainz.findAlbumMusicBrainzId(artistName, albumName));

            if (mbid) {
                const mbData = await retryWithBackoff(() => MusicBrainz.enrichAlbumMetadata(mbid));
                if (mbData) {
                    metadata.musicBrainz = {
                        releaseId: mbid,
                        artistIds: mbData.artistIds,
                        coverArtAvailable: mbData.coverArt !== null,
                        genres: mbData.genres,
                        tags: mbData.tags,
                        releaseType: mbData.releaseType,
                        releaseDate: mbData.releaseDate,
                        label: mbData.label,
                        country: mbData.country,
                    };
                }
            }
        }
    }

    metadataCache.set(cacheKey, metadata);

    return metadata;
}

export async function fetchArtistMetadata(artistName: string, existingMusicBrainzId?: string): Promise<ExternalMetadata> {
    const cacheKey = `artist:${artistName}`;
    const cached = metadataCache.get(cacheKey);
    if (cached) {
        logger.debug(`Using cached metadata for artist: ${artistName}`);
        return cached;
    }

    const metadata: ExternalMetadata = {};

    if (!await checkInternetConnection()) {
        logger.warn('No internet connection, skipping external metadata fetch');
        return metadata;
    }

    if (config.last_fm?.enabled && config.last_fm.api_key) {
        const lfmData = await retryWithBackoff(() => getArtistInfo(artistName));

        if (lfmData?.artist) {
            metadata.lastFm = { artistInfo: lfmData.artist };

            if (!existingMusicBrainzId && lfmData.artist.mbid) {
                existingMusicBrainzId = lfmData.artist.mbid;
            }
        }
    }

    if (config.spotify?.enabled && config.spotify.client_id && config.spotify.client_secret) {
        const { database } = await import('../util.ts');
        const spotifyImages = await retryWithBackoff(() =>
            getArtistCover(artistName, database, config.spotify!.client_id!, config.spotify!.client_secret!)
        );

        if (spotifyImages && spotifyImages.length > 0) {
            metadata.spotify = { artistImages: spotifyImages };
        }
    }

    if (config.musicbrainz?.enabled && existingMusicBrainzId) {
        const mbArtist = await retryWithBackoff(() => MusicBrainz.getArtistById(existingMusicBrainzId));

        if (mbArtist) {
            metadata.musicBrainz = {
                artistIds: [existingMusicBrainzId],
            };
        }
    }

    metadataCache.set(cacheKey, metadata);

    return metadata;
}

export async function fetchTrackMetadata(
    trackTitle: string,
    artistName: string,
    albumName: string,
    existingMusicBrainzId?: string,
): Promise<ExternalMetadata> {
    const cacheKey = `track:${artistName}:${albumName}:${trackTitle}`;
    const cached = metadataCache.get(cacheKey);
    if (cached) {
        logger.debug(`Using cached metadata for track: ${trackTitle}`);
        return cached;
    }

    const metadata: ExternalMetadata = {};

    if (!await checkInternetConnection()) {
        return metadata;
    }

    if (config.musicbrainz?.enabled) {
        if (existingMusicBrainzId) {
            const mbData = await retryWithBackoff(() => MusicBrainz.enrichTrackMetadata(existingMusicBrainzId));

            if (mbData) {
                metadata.musicBrainz = {
                    recordingId: existingMusicBrainzId,
                    artistIds: mbData.artistIds,
                    releaseId: mbData.releaseIds[0],
                    genres: mbData.genres,
                    tags: mbData.tags,
                };
            }
        } else {
            logger.debug(`No MusicBrainz ID for track ${trackTitle}, attempting search`);
            const mbid = await retryWithBackoff(() => MusicBrainz.findTrackMusicBrainzId(artistName, trackTitle, albumName));

            if (mbid) {
                const mbData = await retryWithBackoff(() => MusicBrainz.enrichTrackMetadata(mbid));
                if (mbData) {
                    metadata.musicBrainz = {
                        recordingId: mbid,
                        artistIds: mbData.artistIds,
                        releaseId: mbData.releaseIds[0],
                        genres: mbData.genres,
                        tags: mbData.tags,
                    };
                }
            }
        }
    }

    metadataCache.set(cacheKey, metadata);

    return metadata;
}

export async function getBestCoverArtUrl(albumName: string, artistName: string, musicBrainzReleaseId?: string): Promise<string | null> {
    if (config.musicbrainz?.enabled && musicBrainzReleaseId) {
        const coverArt = await retryWithBackoff(() => MusicBrainz.getCoverArtUrls(musicBrainzReleaseId));

        if (coverArt?.front) {
            logger.info(`Using MusicBrainz cover art for ${albumName}`);
            return coverArt.front;
        }
    }

    if (config.last_fm?.enabled && config.last_fm.api_key) {
        const lfmData = await retryWithBackoff(() => getAlbumInfo(albumName, artistName));

        if (lfmData?.album?.image) {
            // deno-lint-ignore no-explicit-any
            const largeImage = lfmData.album.image.find((i: any) => i.size === 'extralarge' || i.size === 'large');

            if (largeImage?.['#text']) {
                logger.info(`Using Last.fm cover art for ${albumName}`);
                return largeImage['#text'];
            }
        }
    }

    logger.warn(`No cover art found for ${albumName} by ${artistName}`);
    return null;
}

export function pruneMetadataCache(): number {
    return metadataCache.pruneExpired();
}

export function clearMetadataCache(): void {
    metadataCache.clear();
}

export async function getBestArtistCoverUrl(artistName: string, _musicBrainzArtistId?: string): Promise<string | null> {
    if (config.spotify?.enabled && config.spotify.client_id && config.spotify.client_secret) {
        const { database } = await import('../util.ts');
        const spotifyImages = await retryWithBackoff(() =>
            getArtistCover(artistName, database, config.spotify!.client_id!, config.spotify!.client_secret!)
        );

        if (spotifyImages && spotifyImages.length > 0) {
            // deno-lint-ignore no-explicit-any
            const largeImage = spotifyImages.find((img: any) => img.size === 'large');
            if (largeImage?.url) {
                logger.info(`Using Spotify cover art for artist ${artistName}`);
                return largeImage.url;
            }

            if (spotifyImages[0]?.url) {
                logger.info(`Using Spotify cover art for artist ${artistName}`);
                return spotifyImages[0].url;
            }
        }
    }

    if (config.last_fm?.enabled && config.last_fm.api_key) {
        const lfmData = await retryWithBackoff(() => getArtistInfo(artistName));

        if (lfmData?.artist?.image) {
            // deno-lint-ignore no-explicit-any
            const largeImage = lfmData.artist.image.find((i: any) => i.size === 'extralarge' || i.size === 'large' || i.size === 'mega');

            if (largeImage?.['#text']) {
                logger.info(`Using Last.fm cover art for artist ${artistName}`);
                return largeImage['#text'];
            }
        }
    }

    logger.warn(`No cover art found for artist ${artistName}`);
    return null;
}
