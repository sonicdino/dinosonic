import * as path from '@std/path';
import { exists } from '@std/fs/exists';
import { config, database, logger } from '../util.ts';
import { CoverArtSchema } from '../zod.ts';
import type { IPicture } from 'music-metadata';
import type { CoverArtSource } from './types.ts';
import { getBestCoverArtUrl } from './ExternalMetadataService.ts';

interface CoverQuality {
    width: number;
    height: number;
    fileSize: number;
    score: number;
}

const MIME_TO_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
};

const LOCAL_COVER_NAMES = [
    'cover.jpg',
    'cover.png',
    'folder.jpg',
    'folder.png',
    'album.png',
    'album.jpg',
    'front.jpg',
    'front.png',
];

const SOURCE_PRIORITY = {
    'musicbrainz': 5,
    'local': 4,
    'embedded': 3,
    'lastfm': 2,
    'spotify': 1,
    'unknown': 0,
} as const;

function getImageDimensions(data: Uint8Array): { width: number; height: number } | null {
    try {
        const isPNG = data[0] === 0x89 && data[1] === 0x50;
        const isJPEG = data[0] === 0xFF && data[1] === 0xD8;

        if (isPNG) {
            const width = new DataView(data.buffer, 16, 4).getUint32(0);
            const height = new DataView(data.buffer, 20, 4).getUint32(0);
            return { width, height };
        } else if (isJPEG) {
            let offset = 2;
            while (offset < data.length) {
                if (data[offset] !== 0xFF) break;
                const marker = data[offset + 1];
                if (marker === 0xC0 || marker === 0xC2) {
                    const height = new DataView(data.buffer, offset + 5, 2).getUint16(0);
                    const width = new DataView(data.buffer, offset + 7, 2).getUint16(0);
                    return { width, height };
                }
                const segmentLength = new DataView(data.buffer, offset + 2, 2).getUint16(0);
                offset += 2 + segmentLength;
            }
        }
    } catch (error) {
        logger.debug(`Failed to get image dimensions: ${error}`);
    }
    return null;
}

function calculateQualityScore(quality: Partial<CoverQuality>, source: string): number {
    const pixels = (quality.width || 0) * (quality.height || 0);
    const sourcePriority = SOURCE_PRIORITY[source as keyof typeof SOURCE_PRIORITY] || 0;
    return pixels + (sourcePriority * 100000);
}

async function shouldUpgradeCover(
    existingPath: string,
    existingSource: string | undefined,
    newData: Uint8Array,
    newSource: string,
): Promise<boolean> {
    try {
        const existingData = await Deno.readFile(existingPath);
        const existingDims = await getImageDimensions(existingData);
        const newDims = await getImageDimensions(newData);

        if (!existingDims && newDims) return true;
        if (existingDims && !newDims) return false;
        if (!existingDims && !newDims) {
            const existingPriority = SOURCE_PRIORITY[existingSource as keyof typeof SOURCE_PRIORITY] || 0;
            const newPriority = SOURCE_PRIORITY[newSource as keyof typeof SOURCE_PRIORITY] || 0;
            return newPriority > existingPriority;
        }

        const existingScore = calculateQualityScore(
            { width: existingDims?.width, height: existingDims?.height, fileSize: existingData.length },
            existingSource || 'unknown',
        );
        const newScore = calculateQualityScore(
            { width: newDims?.width, height: newDims?.height, fileSize: newData.length },
            newSource,
        );

        return newScore > existingScore;
    } catch (error) {
        logger.error(`Error comparing cover quality: ${error}`);
        return false;
    }
}

function extractFromPictures(pictures: IPicture[]): CoverArtSource | null {
    if (!pictures || pictures.length === 0) return null;

    const frontCover = pictures.find((p) => p.type?.toLowerCase().includes('cover (front)'));

    if (frontCover) {
        return {
            data: frontCover.data,
            format: frontCover.format,
            source: 'embedded',
        };
    }

    const anyCover = pictures.find((p) => p.type?.toLowerCase().startsWith('cover'));

    if (anyCover) {
        return {
            data: anyCover.data,
            format: anyCover.format,
            source: 'embedded',
        };
    }

    return {
        data: pictures[0].data,
        format: pictures[0].format,
        source: 'embedded',
    };
}

async function extractFromLocalFiles(trackPath: string): Promise<CoverArtSource | null> {
    const dir = path.dirname(trackPath);

    for (const coverName of LOCAL_COVER_NAMES) {
        const localCoverPath = path.join(dir, coverName);

        if (await exists(localCoverPath)) {
            try {
                const fileData = await Deno.readFile(localCoverPath);
                const ext = path.extname(localCoverPath).substring(1).toLowerCase();

                return {
                    data: fileData,
                    format: `image/${ext || 'jpeg'}`,
                    source: 'local',
                };
            } catch (error) {
                logger.error(`Error reading local cover ${localCoverPath}: ${error}`);
            }
        }
    }

    return null;
}

async function downloadFromUrl(url: string): Promise<CoverArtSource | null> {
    try {
        logger.debug(`Downloading cover art from ${url}`);
        const response = await fetch(url, {
            headers: { 'Accept': 'image/*' },
        });

        if (!response.ok) {
            logger.warn(`Failed to download cover art from ${url}: ${response.status}`);
            return null;
        }

        if (!response.body) {
            logger.warn(`No response body from ${url}`);
            return null;
        }

        const contentType = response.headers.get('content-type')?.split(';')[0].trim() || '';

        if (!contentType.startsWith('image/')) {
            logger.warn(`Invalid content type from ${url}: ${contentType}`);
            return null;
        }

        const data = new Uint8Array(await response.arrayBuffer());

        const source = url.includes('musicbrainz') || url.includes('coverartarchive')
            ? 'musicbrainz'
            : url.includes('spotify')
                ? 'spotify'
                : url.includes('last.fm') || url.includes('audioscrobbler')
                    ? 'lastfm'
                    : 'unknown';

        return {
            data,
            format: contentType,
            source,
        };
    } catch (error) {
        logger.error(`Error downloading cover art from ${url}: ${error}`);
        return null;
    }
}

async function saveCoverArt(itemId: string, coverData: CoverArtSource): Promise<string | null> {
    const coversDir = path.join(config.data_folder, 'covers');
    await Deno.mkdir(coversDir, { recursive: true }).catch(() => { });

    const ext = MIME_TO_EXT[coverData.format.toLowerCase()] || 'jpg';
    const finalPath = path.join(coversDir, `${itemId}.${ext}`);

    try {
        await Deno.writeFile(finalPath, coverData.data);

        const dimensions = await getImageDimensions(coverData.data);
        const coverArtEntry = CoverArtSchema.safeParse({
            id: itemId,
            mimeType: coverData.format,
            path: finalPath,
            source: coverData.source,
            width: dimensions?.width,
            height: dimensions?.height,
            fileSize: coverData.data.length,
        });

        if (coverArtEntry.success) {
            await database.set(['covers', itemId], coverArtEntry.data);
            const dimStr = dimensions ? `${dimensions.width}x${dimensions.height}` : 'unknown size';
            logger.info(`Stored cover art for ${itemId} (${coverData.source}, ${dimStr}) at ${finalPath}`);
            return finalPath;
        } else {
            logger.error(`Failed to validate cover art entry for ${itemId}: ${JSON.stringify(coverArtEntry.error.issues)}`);
            return null;
        }
    } catch (error) {
        logger.error(`Error writing cover file ${finalPath}: ${error}`);
        return null;
    }
}

export async function storeCoverArt(
    itemId: string,
    options: {
        embeddedPictures?: IPicture[];
        trackPath?: string;
        externalUrl?: string;
        albumName?: string;
        artistName?: string;
        musicBrainzReleaseId?: string;
        forceUpgrade?: boolean;
    },
): Promise<string | null> {
    const existingCoverEntry = await database.get(['covers', itemId]);
    let existingPath = null;
    let existingSource = 'unknown';

    if (existingCoverEntry.value) {
        const parsedExisting = CoverArtSchema.safeParse(existingCoverEntry.value);
        if (parsedExisting.success && await exists(parsedExisting.data.path)) {
            existingPath = parsedExisting.data.path;
            existingSource = parsedExisting.data.source || 'unknown';
        }
    }

    let coverData: CoverArtSource | null = null;

    if (options.embeddedPictures) {
        coverData = extractFromPictures(options.embeddedPictures);
        if (coverData && existingPath && !options.forceUpgrade) {
            if (!await shouldUpgradeCover(existingPath, existingSource, coverData.data, coverData.source)) {
                logger.debug(`Keeping existing cover for ${itemId} (better quality)`);
                return existingPath;
            }
            logger.info(`Upgrading cover for ${itemId}: ${existingSource} -> ${coverData.source}`);
        }
    }

    if (!coverData && options.trackPath) {
        coverData = await extractFromLocalFiles(options.trackPath);
        if (coverData && existingPath && !options.forceUpgrade) {
            if (!await shouldUpgradeCover(existingPath, existingSource, coverData.data, coverData.source)) {
                logger.debug(`Keeping existing cover for ${itemId} (better quality)`);
                return existingPath;
            }
            logger.info(`Upgrading cover for ${itemId}: ${existingSource} -> ${coverData.source}`);
        }
    }

    if (!coverData && options.albumName && options.artistName) {
        const externalUrl = await getBestCoverArtUrl(
            options.albumName,
            options.artistName,
            options.musicBrainzReleaseId,
        );

        if (externalUrl) {
            coverData = await downloadFromUrl(externalUrl);
            if (coverData && existingPath && !options.forceUpgrade) {
                if (!await shouldUpgradeCover(existingPath, existingSource, coverData.data, coverData.source)) {
                    logger.debug(`Keeping existing cover for ${itemId} (better quality)`);
                    return existingPath;
                }
                logger.info(`Upgrading cover for ${itemId}: ${existingSource} -> ${coverData.source}`);
            }
        }
    }

    if (!coverData && options.externalUrl) {
        coverData = await downloadFromUrl(options.externalUrl);
        if (coverData && existingPath && !options.forceUpgrade) {
            if (!await shouldUpgradeCover(existingPath, existingSource, coverData.data, coverData.source)) {
                logger.debug(`Keeping existing cover for ${itemId} (better quality)`);
                return existingPath;
            }
            logger.info(`Upgrading cover for ${itemId}: ${existingSource} -> ${coverData.source}`);
        }
    }

    if (coverData) {
        return await saveCoverArt(itemId, coverData);
    }

    if (existingPath) {
        return existingPath;
    }

    logger.warn(`No cover art found for ${itemId}`);
    return null;
}

export async function coverArtExists(itemId: string): Promise<boolean> {
    const existingCoverEntry = await database.get(['covers', itemId]);
    if (!existingCoverEntry.value) return false;

    const parsedExisting = CoverArtSchema.safeParse(existingCoverEntry.value);
    if (!parsedExisting.success) return false;

    return await exists(parsedExisting.data.path);
}
