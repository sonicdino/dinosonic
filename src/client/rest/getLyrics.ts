import { Context, Hono } from 'hono';
import { config, createResponse, database, getField, logger, separatorsToRegex, validateAuth } from '../../util.ts';
import { Song, StructuredLyrics } from '../../zod.ts';

const getLyrics = new Hono();

async function handlegetLyrics(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artist = await getField(c, 'artist') || '';
    const title = await getField(c, 'title') || '';

    if (!title) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'title'" });
    if (!artist) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'artist'" });

    const track: Song | undefined = (await Array.fromAsync(database.list({ prefix: ['tracks'] }))).map((track) => track.value as Song).find((track) =>
        (track as Song).subsonic.title.toLowerCase().trim() === title.toLowerCase().trim() &&
        (track as Song).subsonic.artist.toLowerCase().trim() === artist.toLowerCase().trim()
    );
    if (track && track.backend.lyrics?.length) {
        return createResponse(c, {
            lyrics: {
                artist: track.subsonic.artist,
                title: track.subsonic.title,
                value: convertToLRC(track.backend.lyrics),
            },
        });
    }

    const lyrics = await fetchLyrics(title, artist);

    return createResponse(c, {
        lyrics: {
            artist,
            title,
            value: lyrics,
        },
    }, 'ok');
}

function convertToLRC(lyrics: StructuredLyrics[]) {
    const syncedLyrics = lyrics.find((lyric: StructuredLyrics) => lyric.synced);
    const unsyncedLyrics = lyrics.find((lyric: StructuredLyrics) => !lyric.synced);

    let lrcContent = '';

    if (syncedLyrics) {
        syncedLyrics.line.forEach((line) => {
            if (line.start !== undefined) {
                const minutes = String(Math.floor(line.start / 60000)).padStart(2, '0');
                const seconds = String(((line.start % 60000) / 1000).toFixed(2)).padStart(5, '0');
                lrcContent += `[${minutes}:${seconds}]${line.value}\n`;
            } else {
                lrcContent += `${line.value}\n`;
            }
        });
    }

    if (unsyncedLyrics) {
        unsyncedLyrics.line.forEach((line) => {
            lrcContent += `${line.value}\n`;
        });
    }

    return lrcContent.trim();
}

async function fetchLyrics(trackName: string, artistName: string): Promise<string | null> {
    const artistNameGet = artistName.split(separatorsToRegex(config.artist_separators))[0];

    // Get in LRCLIB
    const lrclibGetUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistNameGet)}`;

    try {
        const lrclibGetResponse = await fetch(lrclibGetUrl);
        if (lrclibGetResponse.ok) {
            const jsonData = await lrclibGetResponse.json();
            if (jsonData.syncedLyrics) {
                logger.debug('Using LRCLIB Get to fetch lyrics');
                return jsonData.syncedLyrics;
            }
        }
    } catch (error) {
        logger.error('Error fetching from LRCLIB Get:', error);
    }

    // Search in LRCLIB
    const lrclibSearchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${artistName} ${trackName}`)}`;

    try {
        const lrclibSearchResponse = await fetch(lrclibSearchUrl);
        if (lrclibSearchResponse.ok) {
            const jsonData = await lrclibSearchResponse.json();

            if (jsonData && jsonData.length > 0) {
                for (const song of jsonData) {
                    if (
                        (song.name.toLowerCase() === trackName.toLowerCase() || song.trackName.toLowerCase() === trackName.toLowerCase()) &&
                        song.artistName.toLowerCase() === artistName.toLowerCase() &&
                        song.syncedLyrics
                    ) {
                        logger.debug('Using LRCLIB Search');
                        return song.syncedLyrics;
                    }
                }
            }
        }
    } catch (error) {
        logger.error('Error fetching from LRCLIB Search:', error);
    }

    return null;
}

getLyrics.get('/getLyrics', handlegetLyrics);
getLyrics.post('/getLyrics', handlegetLyrics);
getLyrics.get('/getLyrics.view', handlegetLyrics);
getLyrics.post('/getLyrics.view', handlegetLyrics);

export default getLyrics;
