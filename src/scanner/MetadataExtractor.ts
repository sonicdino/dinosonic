import { type IAudioMetadata, parseFile } from 'music-metadata';
import * as path from '@std/path';
import { config, logger, separatorsToRegex } from '../util.ts';
import { type AlbumID3Artists, Genre, ReplayGainSchema, type StructuredLyrics, StructuredLyricsSchema } from '../zod.ts';

const CONTENT_TYPE_MAP: Record<string, string> = {
    'flac': 'audio/flac',
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'm4a': 'audio/mp4',
    'opus': 'audio/opus',
};

function extractLyrics(
    metadata: IAudioMetadata,
    artists: AlbumID3Artists[],
    filePath: string,
): StructuredLyrics[] {
    const lyricsArray: StructuredLyrics[] = [];

    if (!metadata.common.lyrics?.length) return lyricsArray;

    for (const lyricItem of metadata.common.lyrics) {
        const displayArtist = artists[0]?.name || 'Unknown Artist';
        const displayTitle = metadata.common.title || path.parse(filePath).name;

        if (lyricItem.syncText?.length) {
            const lines = lyricItem.syncText.map((line) => ({
                start: line.timestamp,
                value: line.text,
            }));

            const parsed = StructuredLyricsSchema.safeParse({
                displayArtist,
                displayTitle,
                synced: true,
                line: lines,
            });

            if (parsed.success) {
                lyricsArray.push(parsed.data);
            }
        } else if (lyricItem.text) {
            const lines = lyricItem.text.split('\n').map((lineText) => ({
                value: lineText,
            }));

            const parsed = StructuredLyricsSchema.safeParse({
                displayArtist,
                displayTitle,
                synced: false,
                line: lines,
            });

            if (parsed.success) {
                lyricsArray.push(parsed.data);
            }
        }
    }

    return lyricsArray;
}

function extractGenres(metadata: IAudioMetadata): Genre[] | undefined {
    if (!metadata.common.genre?.length) return undefined;

    const genres = metadata.common.genre
        .flatMap((g) => g.split(separatorsToRegex(config.genre_separators)))
        .map((name) => ({ name: name.trim() }))
        .filter((g) => g.name && g.name.length > 0);

    return genres.length > 0 ? genres : undefined;
}

function formatDisplayArtist(artists: AlbumID3Artists[]): string {
    if (artists.length === 0) return 'Unknown Artist';
    if (artists.length === 1) return artists[0].name;

    return artists.slice(0, -1).map((a) => a.name).join(', ') +
        ' & ' +
        artists[artists.length - 1].name;
}

export async function extractAudioMetadata(filePath: string) {
    try {
        const stat = await Deno.stat(filePath);
        const metadata = await parseFile(filePath, {
            duration: true,
            skipCovers: false,
        });

        const fileExtension = path.extname(filePath).substring(1).toLowerCase();
        const genres = extractGenres(metadata);

        // Parse replay gain
        const replayGainParsed = ReplayGainSchema.safeParse({
            trackGain: metadata.common.replaygain_track_gain?.dB,
            trackPeak: metadata.common.replaygain_track_peak,
            albumGain: metadata.common.replaygain_album_gain?.dB,
            albumPeak: metadata.common.replaygain_album_peak,
        });

        return {
            metadata,
            fileInfo: {
                path: filePath,
                size: stat.size,
                lastModified: stat.mtime?.getTime() ?? Date.now(),
                birthtime: stat.birthtime || stat.mtime || new Date(),
                extension: fileExtension,
                contentType: CONTENT_TYPE_MAP[fileExtension] || 'application/octet-stream',
            },
            audioInfo: {
                duration: Math.round(metadata.format.duration || 0),
                bitRate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : undefined,
                bitDepth: metadata.format.bitsPerSample,
                samplingRate: metadata.format.sampleRate,
                channelCount: metadata.format.numberOfChannels,
            },
            tags: {
                title: metadata.common.title || path.parse(filePath).name,
                album: metadata.common.album || 'Unknown Album',
                artist: metadata.common.artist || 'Unknown Artist',
                artists: metadata.common.artists || [],
                albumArtist: metadata.common.albumartist,
                trackNumber: metadata.common.track.no,
                discNumber: metadata.common.disk.no || 1,
                year: metadata.common.year,
                date: metadata.common.date,
                originalYear: metadata.common.originalyear?.toString(),
                genres,
                genreString: genres?.map((g) => g.name).join(', '),
                musicBrainzTrackId: metadata.common.musicbrainz_trackid,
                musicBrainzAlbumId: metadata.common.musicbrainz_albumid,
                musicBrainzArtistId: metadata.common.musicbrainz_artistid,
                releaseType: metadata.common.releasetype,
            },
            embeddedPictures: metadata.common.picture || [],
            replayGain: replayGainParsed.success ? replayGainParsed.data : undefined,
        };
    } catch (error) {
        logger.error(`Failed to extract metadata from ${filePath}: ${error}`);
        throw error;
    }
}

export function processExtractedMetadata(
    extracted: Awaited<ReturnType<typeof extractAudioMetadata>>,
    artists: AlbumID3Artists[],
    albumArtists: AlbumID3Artists[],
) {
    const lyrics = extractLyrics(extracted.metadata, artists, extracted.fileInfo.path);

    return {
        ...extracted,
        displayArtist: formatDisplayArtist(artists),
        displayAlbumArtist: formatDisplayArtist(albumArtists),
        lyrics,
    };
}
