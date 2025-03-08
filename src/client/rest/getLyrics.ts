import { Context, Hono } from 'hono';
import { createResponse, ERROR_MESSAGES, logger, separatorsToRegex, validateAuth } from '../../util.ts';

const getLyrics = new Hono();
const PLACEHOLDER_SEPARATORS = [';', ',', '/'];
const separators = PLACEHOLDER_SEPARATORS;

async function handlegetLyrics(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const artist = c.req.query('artist') || '';
    const title = c.req.query('title') || '';

    if (!artist && !title) return createResponse(c, {}, 'failed', { code: 10, message: ERROR_MESSAGES[10] });
    const lyrics = await fetchLyrics(title, artist);

    return createResponse(c, {
        lyrics: {
            artist,
            title,
            value: lyrics,
        },
    }, 'ok');
}

// TODO: Debug logging
async function fetchLyrics(trackName: string, artistName: string): Promise<string | null> {
    const artistNameGet = artistName.split(separatorsToRegex(separators))[0];

    // Search in LRCLIB
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

    // Search in LRCLIB Search
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

    // Search in NetEase
    const neteaseUrl = `https://music.163.com/api/search/get?offset=0&type=1&s=${encodeURIComponent(`${artistName} ${trackName}`)}`;

    try {
        const neteaseResponse = await fetch(neteaseUrl);
        if (!neteaseResponse.ok) return null;

        const jsonData = await neteaseResponse.json();
        if (!jsonData?.result?.songs || jsonData.result.songs.length === 0) return null;

        for (const song of jsonData.result.songs) {
            if (
                song.name.toLowerCase() === trackName.toLowerCase() &&
                song.artists.some((artist: { name: string }) => artist.name.toLowerCase() === artistName.toLowerCase())
            ) {
                const lyricUrl = `https://music.163.com/api/song/lyric?id=${song.id}&kv=-1&lv=-1`;
                const lyricResponse = await fetch(lyricUrl);

                if (!lyricResponse.ok) return null;

                const lyricJson = await lyricResponse.json();
                logger.debug('Using NetEase');
                return lyricJson.klyric?.lyric || lyricJson.lrc?.lyric || null;
            }
        }
    } catch (error) {
        logger.error(`Error getting NetEase Lyrics for '${trackName}' by '${artistName}'. Error:`, error);
    }

    return null;
}

getLyrics.get('/getLyrics', handlegetLyrics);
getLyrics.post('/getLyrics', handlegetLyrics);
getLyrics.get('/getLyrics.view', handlegetLyrics);
getLyrics.post('/getLyrics.view', handlegetLyrics);

export default getLyrics;
