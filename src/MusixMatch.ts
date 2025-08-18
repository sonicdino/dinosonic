import * as path from '@std/path';
import { exists } from '@std/fs/exists';

const ROOT_URL = 'https://apic-desktop.musixmatch.com/ws/1.1/';

interface TokenData {
    token: string;
    expiration_time: number;
}

export interface MusixmatchTrack {
    track_id: number;
    title: string;
    artist: string;
    album: string;
    image: string;
}

class MusixmatchProvider {
    private token: string | null = null;
    private sessionHeaders = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36',
        'authority': 'apic-desktop.musixmatch.com',
        'cookie': 'AWSELBCORS=0; AWSELB=0',
    };

    private async _get(action: string, query: [string, string][]): Promise<Response | null> {
        if (action !== 'token.get' && !this.token) {
            await this._getToken();
        }

        const params = new URLSearchParams(query);
        params.append('app_id', 'web-desktop-app-v1.0');

        if (this.token) {
            params.append('usertoken', this.token);
        }

        const t = `${Date.now()}`;
        params.append('t', t);

        const url = `${ROOT_URL}${action}?${params.toString()}`;

        try {
            const response = await fetch(url, {
                headers: this.sessionHeaders,
            });

            if (response.ok) {
                return response;
            }
            // deno-lint-ignore no-explicit-any
        } catch (error: any) {
            console.error(`Error fetching from Musixmatch: ${error.message}`);
        }

        return null;
    }

    private async _getToken(): Promise<void> {
        const tokenPath = path.join(globalThis.__tmpDir, 'token.json');
        const currentTime = Math.floor(Date.now() / 1000);

        if (await exists(tokenPath)) {
            try {
                const tokenData: TokenData = JSON.parse(await Deno.readTextFile(tokenPath));
                if (tokenData.token && tokenData.expiration_time && currentTime < tokenData.expiration_time) {
                    this.token = tokenData.token;
                    return;
                }
            } catch (e) {
                console.warn(`Failed to read or parse cached token file, fetching a new one. Error: ${e}`);
            }
        }

        const response = await this._get('token.get', [['user_language', 'en']]);

        if (!response) {
            return;
        }

        const res = await response.json();

        if (res.message.header.status_code === 401) {
            await new Promise(resolve => setTimeout(resolve, 13000));
            return this._getToken();
        }

        const newToken = res.message.body.user_token;
        const expirationTime = currentTime + 600; // 10 minutes expiration

        this.token = newToken;
        const tokenData: TokenData = { token: newToken, expiration_time: expirationTime };

        await Deno.writeTextFile(tokenPath, JSON.stringify(tokenData));
    }

    async getLrcById(trackId: string): Promise<string | null> {
        const response = await this._get('track.subtitle.get', [['track_id', trackId], ['subtitle_format', 'lrc']]);

        if (!response) {
            return null;
        }

        try {
            const res = await response.json();
            const body = res.message.body;

            if (!body) {
                return null;
            }
            return body.subtitle?.subtitle_body;
        } catch (e) {
            console.error(`Error parsing getLrcById response: ${e}`);
            return null;
        }
    }

    async search(title: string, artist: string): Promise<MusixmatchTrack[]> {
        const response = await this._get('track.search', [
            ['q_track', title],
            ['q_artist', artist],
            ['page_size', '5'],
            ['page', '1'],
            ['f_has_lyrics', '1'],
            ['s_track_rating', 'desc'],
            ['quorum_factor', '1.0'],
        ]);

        if (!response) {
            return [];
        }

        try {
            const body = (await response.json()).message.body;
            const tracks = body?.track_list;

            if (!tracks) {
                return [];
            }

            // deno-lint-ignore no-explicit-any
            return tracks.map((t: any) => ({
                track_id: t.track.track_id,
                title: t.track.track_name,
                artist: t.track.artist_name,
                album: t.track.album_name,
                image: t.track.album_coverart_100x100,
            }));
        } catch (e) {
            console.error(`Error parsing search response: ${e}`);
            return [];
        }
    }
}

export const musixmatch = new MusixmatchProvider();