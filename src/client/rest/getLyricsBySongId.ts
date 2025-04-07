import { Context, Hono } from 'hono';
import { config, createResponse, database, getField, logger, separatorsToRegex, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';

const getLyricsBySongId = new Hono();

function timeToMs(timestamp: string): number {
    const match = timestamp.match(/(\d+):(\d+)[.:](\d+)/);
    if (!match) return 0;
    const [, minutes, seconds, milliseconds] = match.map(Number);
    return (minutes * 60 + seconds) * 1000 + milliseconds;
}

async function handlegetLyricsBySongId(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = await getField(c, 'id');
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });
    const track = (await database.get(['tracks', id])).value as Song | null;
    if (!track) return createResponse(c, {}, 'failed', { code: 70, message: 'Song not found' });
    if (track.backend.lyrics?.length) return createResponse(c, { lyricsList: { structuredLyrics: track.backend.lyrics } }, 'ok');

    const lyrics = await fetchLyrics(track.subsonic.title, track.subsonic.artist);
    if (!lyrics) return createResponse(c, {}, 'ok');

    const lines = lyrics.split('\n').filter((line) => line.trim());

    const Lyrics = lines
        .filter((line) => line.match(/^\[\d+:\d+\.\d+]/))
        .map((line) => {
            const match = line.match(/^\[(\d+:\d+\.\d+)](.*)/);
            return match ? { start: timeToMs(match[1]), value: match[2].trim() } : null;
        })
        .filter((item) => item !== null);

    const structuredLyrics = [
        {
            displayArtist: track.subsonic.artist,
            displayTitle: track.subsonic.title,
            lang: 'xxx',
            synced: true,
            line: Lyrics,
        },
        {
            displayArtist: track.subsonic.artist,
            displayTitle: track.subsonic.title,
            lang: 'xxx',
            synced: false,
            line: Lyrics.map(({ value }) => ({ value })),
        },
    ];
    return createResponse(c, {
        lyricsList: { structuredLyrics },
    }, 'ok');
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

getLyricsBySongId.get('/getLyricsBySongId', handlegetLyricsBySongId);
getLyricsBySongId.post('/getLyricsBySongId', handlegetLyricsBySongId);
getLyricsBySongId.get('/getLyricsBySongId.view', handlegetLyricsBySongId);
getLyricsBySongId.post('/getLyricsBySongId.view', handlegetLyricsBySongId);

export default getLyricsBySongId;
