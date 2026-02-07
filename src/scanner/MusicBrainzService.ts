// MusicBrainz API integration service
import { logger } from '../util.ts';
import type { MusicBrainzArtist, MusicBrainzRecording, MusicBrainzRelease } from './types.ts';

const MUSICBRAINZ_API_BASE = 'https://musicbrainz.org/ws/2';
const COVERART_API_BASE = 'https://coverartarchive.org';
const RATE_LIMIT_DELAY = 1000; // MusicBrainz requires 1 request per second
const USER_AGENT = 'Dinosonic/0.5.4 (https://github.com/sonicdino/dinosonic)';

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
    }

    lastRequestTime = Date.now();

    return await fetch(url, {
        headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
        },
    });
}

export async function getRecordingById(mbid: string): Promise<MusicBrainzRecording | null> {
    try {
        const url = `${MUSICBRAINZ_API_BASE}/recording/${mbid}?fmt=json&inc=artists+releases+artist-credits+tags+genres`;
        logger.debug(`Fetching MusicBrainz recording: ${mbid}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            logger.warn(`MusicBrainz recording ${mbid} not found: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as MusicBrainzRecording;
    } catch (error) {
        logger.error(`Error fetching MusicBrainz recording ${mbid}: ${error}`);
        return null;
    }
}

export async function getReleaseById(mbid: string): Promise<MusicBrainzRelease | null> {
    try {
        const url = `${MUSICBRAINZ_API_BASE}/release/${mbid}?fmt=json&inc=artists+recordings+artist-credits+media+tags+genres+release-groups+labels`;
        logger.debug(`Fetching MusicBrainz release: ${mbid}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            logger.warn(`MusicBrainz release ${mbid} not found: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as MusicBrainzRelease;
    } catch (error) {
        logger.error(`Error fetching MusicBrainz release ${mbid}: ${error}`);
        return null;
    }
}

export async function getArtistById(mbid: string): Promise<MusicBrainzArtist | null> {
    try {
        const url = `${MUSICBRAINZ_API_BASE}/artist/${mbid}?fmt=json&inc=tags+genres`;
        logger.debug(`Fetching MusicBrainz artist: ${mbid}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            logger.warn(`MusicBrainz artist ${mbid} not found: ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data as MusicBrainzArtist;
    } catch (error) {
        logger.error(`Error fetching MusicBrainz artist ${mbid}: ${error}`);
        return null;
    }
}

export async function getCoverArtUrls(
    releaseId: string,
): Promise<{ front?: string; back?: string; images: Array<{ id: string; image: string; thumbnails: { small: string; large: string } }> } | null> {
    try {
        const url = `${COVERART_API_BASE}/release/${releaseId}`;
        logger.debug(`Fetching cover art for release: ${releaseId}`);

        const response = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
        });

        if (!response.ok) {
            logger.debug(`No cover art found for release ${releaseId}: ${response.status}`);
            return null;
        }

        const data = await response.json();
        // deno-lint-ignore no-explicit-any
        const result: any = {
            images: data.images || [],
        };

        // Find front and back covers
        for (const image of data.images || []) {
            if (image.front) {
                result.front = image.image;
            }
            if (image.back) {
                result.back = image.image;
            }
        }

        return result;
    } catch (error) {
        logger.error(`Error fetching cover art for ${releaseId}: ${error}`);
        return null;
    }
}

export async function searchRecording(artist: string, title: string, limit = 5): Promise<MusicBrainzRecording[]> {
    try {
        const query = `recording:"${title}" AND artist:"${artist}"`;
        const url = `${MUSICBRAINZ_API_BASE}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;

        logger.debug(`Searching MusicBrainz recordings: ${artist} - ${title}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            logger.warn(`MusicBrainz recording search failed: ${response.status}`);
            return [];
        }

        const data = await response.json();
        return data.recordings || [];
    } catch (error) {
        logger.error(`Error searching MusicBrainz recordings: ${error}`);
        return [];
    }
}

export async function searchRelease(artist: string, album: string, limit = 5): Promise<MusicBrainzRelease[]> {
    try {
        const query = `release:"${album}" AND artist:"${artist}"`;
        const url = `${MUSICBRAINZ_API_BASE}/release?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;

        logger.debug(`Searching MusicBrainz releases: ${artist} - ${album}`);

        const response = await rateLimitedFetch(url);

        if (!response.ok) {
            logger.warn(`MusicBrainz release search failed: ${response.status}`);
            return [];
        }

        const data = await response.json();
        return data.releases || [];
    } catch (error) {
        logger.error(`Error searching MusicBrainz releases: ${error}`);
        return [];
    }
}

export async function enrichAlbumMetadata(mbid: string) {
    const release = await getReleaseById(mbid);
    if (!release) return null;

    const coverArt = await getCoverArtUrls(mbid);

    const genresFromGenreField = release.genres?.map((g) => g.name) || [];
    const genresFromTags = release.tags?.filter((t) => t.count >= 1).map((t) => t.name) || [];
    const allGenres = [...new Set([...genresFromGenreField, ...genresFromTags])];

    logger.debug(
        `MusicBrainz release ${mbid}: ${genresFromGenreField.length} official genres, ${genresFromTags.length} tag genres, ${allGenres.length} total`,
    );

    const releaseType = release['release-group']?.['primary-type'];
    const secondaryTypes = release['release-group']?.['secondary-types'] || [];
    const labelInfo = release['label-info']?.[0];
    const labelName = labelInfo?.label?.name;

    return {
        release,
        coverArt,
        artistIds: release['artist-credit']?.map((ac) => ac.artist.id) || [],
        genres: allGenres,
        tags: genresFromTags,
        releaseType: releaseType,
        secondaryTypes: secondaryTypes,
        label: labelName,
        releaseDate: release.date,
        country: release.country,
        status: release.status,
    };
}

export async function enrichTrackMetadata(mbid: string) {
    const recording = await getRecordingById(mbid);
    if (!recording) return null;

    const genresFromGenreField = recording.genres?.map((g) => g.name) || [];
    const genresFromTags = recording.tags?.filter((t) => t.count >= 1).map((t) => t.name) || [];
    const allGenres = [...new Set([...genresFromGenreField, ...genresFromTags])];

    return {
        recording,
        artistIds: recording['artist-credit']?.map((ac) => ac.artist.id) || [],
        releaseIds: recording.releases?.map((r) => r.id) || [],
        genres: allGenres,
        tags: genresFromTags,
    };
}

export async function findTrackMusicBrainzId(artist: string, title: string, albumName?: string): Promise<string | null> {
    const recordings = await searchRecording(artist, title);

    if (!recordings.length) {
        logger.debug(`No MusicBrainz recordings found for: ${artist} - ${title}`);
        return null;
    }

    // If album name provided, try to find best match
    if (albumName) {
        for (const recording of recordings) {
            if (recording.releases) {
                for (const release of recording.releases) {
                    if (release.title.toLowerCase().includes(albumName.toLowerCase())) {
                        logger.info(`Found MusicBrainz recording ID for ${artist} - ${title}: ${recording.id}`);
                        return recording.id;
                    }
                }
            }
        }
    }

    // Return first result if no album match
    logger.info(`Using first MusicBrainz recording match for ${artist} - ${title}: ${recordings[0].id}`);
    return recordings[0].id;
}

export async function findAlbumMusicBrainzId(artist: string, album: string): Promise<string | null> {
    const releases = await searchRelease(artist, album);

    if (!releases.length) {
        logger.debug(`No MusicBrainz releases found for: ${artist} - ${album}`);
        return null;
    }

    // Prefer releases with cover art
    for (const release of releases) {
        if (release['cover-art-archive']?.front) {
            logger.info(`Found MusicBrainz release ID with cover art for ${artist} - ${album}: ${release.id}`);
            return release.id;
        }
    }

    // Return first result
    logger.info(`Using first MusicBrainz release match for ${artist} - ${album}: ${releases[0].id}`);
    return releases[0].id;
}
