// Here houses LastFM related functions, srobbling, metadata retrieval etc.

import { config, logger, signParams } from './util.ts'; // Added logger
import { Song, User } from './zod.ts';

export async function getArtistInfo(artist: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${
        encodeURIComponent(artist)
    }&api_key=${config.last_fm?.api_key}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    return req.json();
}

export async function getAlbumInfo(title: string, artist: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${
        encodeURIComponent(artist)
    }&album=${title}&api_key=${config.last_fm?.api_key}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    const json = await req.json();
    return json;
}

export async function getTopTracks(artist: string, count = 50, mbid?: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptracks&${
        mbid ? `mbid=${encodeURIComponent(mbid)}` : `artist=${encodeURIComponent(artist)}`
    }&count=${count}&api_key=${config.last_fm?.api_key}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    const json = await req.json();
    return json.toptracks?.track.map((track: Record<string, string | number>, index: number) => {
        return { name: track.name, rank: index + 1 };
    }) || [];
}

/**
 * Retrieves the Last.fm username associated with a given session key.
 * Requires API key, session key, and API secret for signing.
 * @param sessionKey The user's Last.fm session key (sk).
 * @returns The Last.fm username string, or null if an error occurs or keys are missing.
 */
export async function getUsernameFromSessionKey(sessionKey: string): Promise<string | null> {
    // Check if necessary config is available
    if (!config.last_fm?.api_key || !config.last_fm.api_secret) {
        logger.error('Last.fm getUsernameFromSessionKey: API key or API secret is missing in config.');
        return null;
    }
    if (!sessionKey) {
        logger.error('Last.fm getUsernameFromSessionKey: Session key was not provided.');
        return null;
    }

    // Construct URL parameters for user.getInfo authenticated call
    const params = new URLSearchParams({
        method: 'user.getInfo',
        api_key: config.last_fm.api_key,
        sk: sessionKey, // Provide the session key
        format: 'json',
        // No 'user' parameter - defaults to the authenticated user (owner of sk)
    });

    // Calculate and append the API signature (required when using 'sk')
    params.append('api_sig', signParams(params, config.last_fm.api_secret));

    try {
        // Make GET request
        const reqUrl = `https://ws.audioscrobbler.com/2.0/?${params.toString()}`;
        const response = await fetch(reqUrl);

        if (!response.ok) {
            let errorMsg = response.statusText;
            try {
                const errorData = await response.json();
                errorMsg = errorData.message || errorMsg;
            } catch (_) { /* Ignore */ }
            logger.error(`Last.fm: Failed to get user info for session key. Status: ${response.status}, Error: ${errorMsg}`);
            return null;
        }

        const data = await response.json();

        if (data.error) {
            // Specific error code for invalid session key is 9
            if (data.error === 9) {
                logger.warn(`Last.fm: Provided session key is invalid or expired.`);
            } else {
                logger.error(`Last.fm: API error getting user info for session key. Error ${data.error}: ${data.message}`);
            }
            return null;
        }

        // Extract username from the response: { user: { name: "...", ... } }
        const username = data?.user?.name;
        if (!username) {
            logger.error(`Last.fm: Could not extract username from user.getInfo response for session key.`);
            console.debug('Last.fm getUsernameFromSessionKey response:', data); // Log response for debugging
            return null;
        }

        logger.debug(`Last.fm: Successfully retrieved username "${username}" for session key.`);
        return username as string;
    } catch (error) {
        logger.error(`Last.fm: Exception during getUsernameFromSessionKey: ${error}`);
        return null;
    }
}

/**
 * Creates a normalized key for track lookup.
 * @param artist Artist name
 * @param track Track name
 * @returns Normalized key string "artist||track" in lowercase.
 */
export function createTrackMapKey(artist: string, track: string): string {
    return `${artist?.toLowerCase() || ''}||${track?.toLowerCase() || ''}`;
}

/**
 * Fetches all loved tracks for a user from Last.fm, handling pagination.
 * @param username The Last.fm username.
 * @returns A Map where keys are normalized "artist||track" strings and values are the UTS love timestamps (number), or null on error.
 */
export async function getUserLovedTracksMap(username: string): Promise<Map<string, number> | null> {
    if (!config.last_fm?.api_key) {
        logger.error('Last.fm getUserLovedTracksMap: API key missing.');
        return null;
    }
    if (!username) {
        logger.error('Last.fm getUserLovedTracksMap: Username is required.');
        return null;
    }

    const lovedTracksMap = new Map<string, number>();
    let currentPage = 1;
    const limit = 200; // Max allowed by API is typically 200-1000, 200 is safe.
    let totalPages = 1; // Assume at least one page initially

    logger.info(`Last.fm: Fetching loved tracks for user "${username}"...`);

    try {
        do {
            const params = new URLSearchParams({
                method: 'user.getLovedTracks',
                user: username,
                api_key: config.last_fm.api_key,
                format: 'json',
                limit: limit.toString(),
                page: currentPage.toString(),
            });

            const reqUrl = `https://ws.audioscrobbler.com/2.0/?${params.toString()}`;
            const response = await fetch(reqUrl);

            if (!response.ok) {
                let errorMsg = response.statusText;
                try {
                    const errorData = await response.json();
                    errorMsg = errorData.message || errorMsg;
                    // deno-lint-ignore no-empty
                } catch (_) {}
                logger.error(
                    `Last.fm: Failed to fetch loved tracks page ${currentPage} for "${username}". Status: ${response.status}, Error: ${errorMsg}`,
                );
                return null; // Abort on error
            }

            const data = await response.json();

            if (data.error) {
                logger.error(`Last.fm: API error fetching loved tracks page ${currentPage} for "${username}". Error ${data.error}: ${data.message}`);
                return null; // Abort on API error
            }

            if (!data.lovedtracks || !data.lovedtracks.track) {
                logger.warn(`Last.fm: Unexpected response structure for loved tracks page ${currentPage} for "${username}".`);
                // If it's the first page and no tracks found, it's valid, return empty map
                if (currentPage === 1 && (!data.lovedtracks['@attr'] || parseInt(data.lovedtracks['@attr'].total || '0') === 0)) {
                    logger.info(`Last.fm: User "${username}" has no loved tracks.`);
                    return lovedTracksMap; // Return empty map
                }
                // Otherwise, consider it an error for subsequent pages or unexpected format
                return null;
            }

            // Update total pages from the first page response
            if (currentPage === 1) {
                totalPages = parseInt(data.lovedtracks['@attr']?.totalPages || '1');
                const totalTracks = parseInt(data.lovedtracks['@attr']?.total || '0');
                logger.info(`Last.fm: Found ${totalTracks} loved tracks for "${username}" across ${totalPages} pages.`);
            }

            const tracks = Array.isArray(data.lovedtracks.track) ? data.lovedtracks.track : [data.lovedtracks.track];

            for (const track of tracks) {
                if (track?.name && track.artist?.name && track.date?.uts) {
                    const key = createTrackMapKey(track.artist.name, track.name);
                    const timestampUTS = parseInt(track.date.uts);
                    if (!isNaN(timestampUTS)) {
                        // If duplicate found, keep the newest timestamp (unlikely but possible)
                        if (!lovedTracksMap.has(key) || timestampUTS > (lovedTracksMap.get(key) ?? 0)) {
                            lovedTracksMap.set(key, timestampUTS);
                        }
                    }
                }
            }

            currentPage++;
        } while (currentPage <= totalPages);

        logger.info(`Last.fm: Successfully fetched ${lovedTracksMap.size} unique loved tracks for "${username}".`);
        return lovedTracksMap;
    } catch (error) {
        logger.error(`Last.fm: Exception during getUserLovedTracksMap for "${username}": ${error}`);
        return null;
    }
}

export async function scrobble(user: User, submission: boolean, time: Date, track: Song) {
    if (config.last_fm?.enable_scrobbling && config.last_fm.api_key && config.last_fm.api_secret) {
        if (user?.backend.lastFMSessionKey) {
            const sig = new URLSearchParams({
                method: submission ? 'track.scrobble' : 'track.updateNowPlaying',
                api_key: config.last_fm.api_key,
                sk: user.backend.lastFMSessionKey,
                artist: track.subsonic.artist,
                track: track.subsonic.title,
                album: track.subsonic.album,
                timestamp: Math.floor(time.getTime() / 1000).toString(),
                format: 'json',
            });

            // Append API signature
            sig.append('api_sig', signParams(sig, config.last_fm.api_secret));

            try {
                const response = await fetch('https://ws.audioscrobbler.com/2.0/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: sig,
                });

                const data = await response.json();
                if (!response.ok || data.error) {
                    // Added more detailed logging, similar to new functions
                    logger.error(
                        `Last.fm: Failed to ${
                            submission ? 'scrobble' : 'updateNowPlaying'
                        } for track ${track.subsonic.artist} - ${track.subsonic.title}. Error: ${data.message || response.statusText}`,
                    );
                    return false;
                }
                return true;
            } catch (error) {
                logger.error(
                    `Last.fm: Exception during ${
                        submission ? 'scrobble' : 'updateNowPlaying'
                    } for track ${track.subsonic.artist} - ${track.subsonic.title}: ${error}`,
                );
                return false;
            }
        }
    }
    return false; // Added return false if initial conditions not met
}

/**
 * Sets the love status of a track on Last.fm.
 * @param user The user object with Last.fm session key.
 * @param artist The artist name.
 * @param trackName The track name.
 * @param loved True to love the track, false to unlove.
 * @returns True if successful, false otherwise.
 */
export async function setTrackLoveStatus(
    user: User,
    artist: string,
    trackName: string,
    loved: boolean,
) {
    if (config.last_fm?.enable_scrobbling && config.last_fm.api_key && config.last_fm.api_secret && user?.backend.lastFMSessionKey) {
        const params = new URLSearchParams({
            method: loved ? 'track.love' : 'track.unlove',
            api_key: config.last_fm.api_key,
            sk: user.backend.lastFMSessionKey,
            artist: artist,
            track: trackName,
            format: 'json',
        });
        params.append('api_sig', signParams(params, config.last_fm.api_secret));

        try {
            const response = await fetch('https://ws.audioscrobbler.com/2.0/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params,
            });
            const data = await response.json();
            if (!response.ok || data.error) {
                logger.error(
                    `Last.fm: Failed to ${loved ? 'love' : 'unlove'} track "${artist} - ${trackName}". Error: ${data.message || response.statusText}`,
                );
                return false;
            }
            logger.debug(`Last.fm: Track "${artist} - ${trackName}" ${loved ? 'loved' : 'unloved'} successfully.`);
            return true;
        } catch (error) {
            logger.error(`Last.fm: Exception while trying to ${loved ? 'love' : 'unlove'} track "${artist} - ${trackName}": ${error}`);
            return false;
        }
    }
    return false;
}
