import * as path from '@std/path';
import { exists } from '@std/fs/exists';

const ROOT_URL = 'https://apic-desktop.musixmatch.com/ws/1.1/';

interface TokenData {
    token: string;
    expiration_time: number;
}

export interface LyricSearchInfo {
    title: string;
    artist: string;
    album?: string;
    duration?: number;
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

            const setCookie = response.headers.get('set-cookie');
            if (setCookie) {
                this.sessionHeaders.cookie = setCookie;
            }

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
        const tokenPath = path.join(globalThis.__tmpDir, 'musixmatch_token.json');
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
            await new Promise((resolve) => setTimeout(resolve, 13000));
            return this._getToken();
        }

        const newToken = res.message.body.user_token;
        const expirationTime = currentTime + 600; // 10 minutes expiration

        this.token = newToken;
        const tokenData: TokenData = { token: newToken, expiration_time: expirationTime };

        await Deno.writeTextFile(tokenPath, JSON.stringify(tokenData));
    }

    /**
     * Searches for lyrics using detailed track information for a more accurate match.
     * @param info - The track information.
     * @returns The LRC-formatted lyrics string, or null if not found.
     */
    async getLyrics(info: LyricSearchInfo): Promise<string | null> {
        const query: [string, string][] = [
            ['q_track', info.title],
            ['q_artist', info.artist],
            ['namespace', 'lyrics_richsynched'],
            ['subtitle_format', 'lrc'],
        ];

        if (info.album) {
            query.push(['q_album', info.album]);
        }
        if (info.duration) {
            query.push(['q_duration', Math.round(info.duration).toString()]);
        }

        const response = await this._get('macro.subtitles.get', query);

        if (!response) {
            return null;
        }

        try {
            const data = await response.json();

            const lrcBody = data.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body;

            if (lrcBody && lrcBody.trim() !== '') {
                return lrcBody;
            }
            return null;
        } catch (e) {
            console.error(`Error parsing getLyrics response: ${e}`);
            return null;
        }
    }
}

export const musixmatch = new MusixmatchProvider();
