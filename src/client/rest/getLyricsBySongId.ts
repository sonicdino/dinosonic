import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, logger, validateAuth } from '../../util.ts';
import { Song } from '../../zod.ts';
import * as path from '@std/path';
import { ensureDir } from '@std/fs/ensure-dir';
import { exists } from '@std/fs/exists';
import { musixmatch } from '../../MusixMatch.ts';

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

    if (track.backend.lyrics?.length) {
        return createResponse(c, { lyricsList: { structuredLyrics: track.backend.lyrics } }, 'ok');
    }

    const cacheLyricsDir = path.join(globalThis.__tmpDir, 'cache', 'lyrics');
    await ensureDir(cacheLyricsDir);
    const cachedLyricsPath = path.join(cacheLyricsDir, `${id}.lrc`);
    let lyrics: string | null = null;

    if (await exists(cachedLyricsPath)) {
        try {
            logger.debug(`Serving cached lyrics for song ID: ${id}`);
            lyrics = await Deno.readTextFile(cachedLyricsPath);
        } catch (e) {
            logger.warn(`Failed to read cached lyrics file ${cachedLyricsPath}, fetching from network: ${e}`);
        }
    }

    if (!lyrics) {
        lyrics = await fetchLyrics(track.subsonic.title, track.subsonic.artists.map(artists => artists.name).join(", "), track.subsonic.artist, track.subsonic.album, track.subsonic.duration);

        if (lyrics) {
            try {
                await Deno.writeTextFile(cachedLyricsPath, lyrics);
                logger.debug(`Successfully cached lyrics for song ID: ${id}`);
            } catch (e) {
                logger.error(`Failed to write lyrics to cache file ${cachedLyricsPath}: ${e}`);
            }
        }
    }

    if (!lyrics) return createResponse(c, {}, 'ok');

    const lines = lyrics.split('\n').filter((line) => line.trim());

    const syncedLyrics = lines
        .map((line) => {
            const match = line.match(/^\[(\d{2,}:\d{2}[.:]\d{2,3})](.*)/);
            return match ? { start: timeToMs(match[1]), value: match[2].trim() } : null;
        })
        .filter((item): item is { start: number; value: string } => item !== null && item.value !== '');

    const unsyncedLyrics = lines
        .filter(line => !line.startsWith('['))
        .map(value => ({ value }));

    const structuredLyrics = [];
    if (syncedLyrics.length > 0) {
        structuredLyrics.push({
            displayArtist: track.subsonic.artist,
            displayTitle: track.subsonic.title,
            lang: 'xxx',
            synced: true,
            line: syncedLyrics,
        });
    }

    if (unsyncedLyrics.length > 0) {
        structuredLyrics.push({
            displayArtist: track.subsonic.artist,
            displayTitle: track.subsonic.title,
            lang: 'xxx',
            synced: false,
            line: unsyncedLyrics,
        });
    }

    return createResponse(c, { lyricsList: { structuredLyrics } }, 'ok');
}

async function _searchLrclib(artistNameToSearch: string, trackName: string, albumName: string, duration: number): Promise<string | null> {
    const lrclibGetUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistNameToSearch)
        }&album_name=${encodeURIComponent(albumName)}&duration=${encodeURIComponent(duration)}`;

    try {
        const lrclibGetResponse = await fetch(lrclibGetUrl);
        if (lrclibGetResponse.ok) {
            const jsonData = await lrclibGetResponse.json();
            if (jsonData && jsonData.syncedLyrics) {
                logger.debug(`Found lyrics using LRCLIB Get with artist: "${artistNameToSearch}"`);
                return jsonData.syncedLyrics;
            }
        }
    } catch (error) {
        logger.error(`Error fetching from LRCLIB Get with artist "${artistNameToSearch}":`, error);
    }

    const lrclibSearchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${artistNameToSearch} ${trackName}`)}`;

    try {
        const lrclibSearchResponse = await fetch(lrclibSearchUrl);
        if (lrclibSearchResponse.ok) {
            const jsonData = await lrclibSearchResponse.json();
            if (jsonData && jsonData.length > 0) {
                // deno-lint-ignore no-explicit-any
                const bestMatch = jsonData.find((song: any) =>
                    song.trackName.toLowerCase() === trackName.toLowerCase() &&
                    song.artistName.toLowerCase() === artistNameToSearch.toLowerCase() &&
                    song.syncedLyrics
                );

                if (bestMatch) {
                    logger.debug(`Found lyrics using LRCLIB Search with artist: "${artistNameToSearch}"`);
                    return bestMatch.syncedLyrics;
                }
            }
        }
    } catch (error) {
        logger.error(`Error fetching from LRCLIB Search with artist "${artistNameToSearch}":`, error);
    }

    return null;
}

async function fetchLyrics(trackName: string, artistNames: string, artistName: string, albumName: string, duration: number): Promise<string | null> {
    const fullArtistString = artistNames.trim();
    const mainArtist = artistName.trim();

    logger.debug(`Attempting to fetch lyrics with full artist string: "${fullArtistString}"`);
    let lyrics = await _searchLrclib(fullArtistString, trackName, albumName, duration);
    if (lyrics) {
        return lyrics;
    }

    if (mainArtist.toLowerCase() !== fullArtistString.toLowerCase()) {
        logger.debug(`Fetching with full artist string failed, retrying with main artist: "${mainArtist}"`);
        lyrics = await _searchLrclib(mainArtist, trackName, albumName, duration);
        if (lyrics) {
            return lyrics;
        }
    }

    // MusixMatch is always last because even with the
    // duration defined, Lyrics can still be a little bit offset.
    try {
        // Trying with Multi artists
        let lyrics = await musixmatch.getLyrics({
            title: trackName,
            artist: fullArtistString,
            album: albumName,
            duration: duration,
        });

        if (lyrics) {
            logger.debug(`Successfully fetched lyrics from Musixmatch with full artist string.`);
            return lyrics;
        }
        // Fallback to one artist
        lyrics = await musixmatch.getLyrics({
            title: trackName,
            artist: mainArtist,
            album: albumName,
            duration: duration,
        });

        if (lyrics) {
            logger.debug(`Successfully fetched lyrics from Musixmatch with single artist string.`);
            return lyrics;
        }
    } catch (error) {
        logger.error(`An error occurred while fetching lyrics from Musixmatch: ${error}`);
    }

    logger.debug(`No lyrics found for "${trackName}" by "${artistName}" after all attempts.`);
    return null;
}

getLyricsBySongId.get('/getLyricsBySongId', handlegetLyricsBySongId);
getLyricsBySongId.post('/getLyricsBySongId', handlegetLyricsBySongId);
getLyricsBySongId.get('/getLyricsBySongId.view', handlegetLyricsBySongId);
getLyricsBySongId.post('/getLyricsBySongId.view', handlegetLyricsBySongId);

export default getLyricsBySongId;