import { Context, Hono } from 'hono';
import { createResponse, database, getField, logger, separatorsToRegex, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';

const getLyricsBySongId = new Hono();
// TODO: Integrade Separators.
const PLACEHOLDER_SEPARATORS = [';', '/'];
const separators = PLACEHOLDER_SEPARATORS;

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
    if (track.backend.lyrics) return createResponse(c, { lyricsList: { structuredLyrics: track.backend.lyrics } }, 'ok');

    const lyrics = await fetchLyrics(track.subsonic.title, track.subsonic.artist);
    if (!lyrics) return createResponse(c, {}, 'ok');

    const lines = lyrics.split('\n').filter((line) => line.trim());
    const offset = parseInt(lines.find((line) => line.startsWith('[offset:'))?.match(/-?\d+/)?.[0] || '0');

    const Lyrics = lines
        .filter((line) => line.match(/^\[\d+:\d+\.\d+]/))
        .map((line) => {
            const match = line.match(/^\[(\d+:\d+\.\d+)](.*)/);
            return match ? { start: timeToMs(match[1]) + offset, value: match[2].trim() } : null;
        })
        .filter((item) => item !== null);

    const structuredLyrics = [
        {
            displayArtist: track.subsonic.artist,
            displayTitle: track.subsonic.title,
            lang: 'xxx',
            offset: Number(offset),
            synced: true,
            line: Lyrics,
        },
        {
            displayArtist: track.subsonic.artist,
            displayTitle: track.subsonic.title,
            lang: 'xxx',
            offset: 100,
            synced: false,
            line: Lyrics.map(({ value }) => ({ value })),
        },
    ];

    return createResponse(c, {
        lyricsList: { structuredLyrics },
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

getLyricsBySongId.get('/getLyricsBySongId', handlegetLyricsBySongId);
getLyricsBySongId.post('/getLyricsBySongId', handlegetLyricsBySongId);
getLyricsBySongId.get('/getLyricsBySongId.view', handlegetLyricsBySongId);
getLyricsBySongId.post('/getLyricsBySongId.view', handlegetLyricsBySongId);

export default getLyricsBySongId;
