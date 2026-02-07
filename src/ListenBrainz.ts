import { config, logger } from './util.ts';
import { Song, User } from './zod.ts';

const API_URL = 'https://api.listenbrainz.org';

/**
 * Submits a listen to ListenBrainz using a user-provided token.
 * @param user The user object containing the ListenBrainz user token.
 * @param submission True for a scrobble, false for a "now playing" update.
 * @param time The timestamp of the listen (only used for scrobbles).
 * @param track The song being scrobbled.
 * @returns True on success, false on failure.
 */
export async function scrobble(user: User, submission: boolean, time: Date, track: Song) {
    if (!config.listenbrainz?.enable_scrobbling || !user?.backend.listenBrainzToken) {
        return false;
    }

    const listenType = submission ? 'single' : 'playing_now';
    const payload = {
        listen_type: listenType,
        payload: [
            {
                ...(submission && { listened_at: Math.floor(time.getTime() / 1000) }),
                track_metadata: {
                    artist_name: track.subsonic.artist,
                    track_name: track.subsonic.title,
                    release_name: track.subsonic.album,
                    additional_info: {
                        duration: track.subsonic.duration,
                    },
                },
            },
        ],
    };

    try {
        const response = await fetch(`${API_URL}/1/submit-listens`, {
            method: 'POST',
            headers: {
                // The Authorization header format is the same
                'Authorization': `Token ${user.backend.listenBrainzToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        const data = await response.json();
        if (!response.ok || data.status !== 'ok') {
            logger.error(`ListenBrainz: Failed to ${listenType}. Error: ${data.error || response.statusText}`);
            return false;
        }
        logger.debug(`ListenBrainz: Successfully submitted ${listenType} for "${track.subsonic.artist} - ${track.subsonic.title}"`);
        return true;
    } catch (error) {
        logger.error(`ListenBrainz: Exception during ${listenType}: ${error}`);
        return false;
    }
}

/**
 * Validates a ListenBrainz user token.
 * @param token The user token to validate.
 * @returns An object with { valid: boolean, userName?: string }
 */
export async function validateToken(token: string): Promise<{ valid: boolean; userName?: string }> {
    if (!token) {
        return { valid: false };
    }

    try {
        const response = await fetch(`${API_URL}/1/validate-token`, {
            method: 'GET',
            headers: {
                'Authorization': `Token ${token}`,
            },
        });

        const data = await response.json();

        if (response.ok && data.valid === true) {
            logger.debug(`ListenBrainz: Token is valid for user "${data.user_name}".`);
            return { valid: true, userName: data.user_name };
        } else {
            logger.warn(`ListenBrainz: Token validation failed. Reason: ${data.message}`);
            return { valid: false };
        }
    } catch (error) {
        logger.error(`ListenBrainz: Exception during token validation: ${error}`);
        return { valid: false };
    }
}
