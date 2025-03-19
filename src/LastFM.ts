// Here houses LastFM related functions, srobbling, metadata retrieval etc.

export async function getArtistInfo(artist: string, apiKey?: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    return req.json();
}

export async function getAlbumInfo(title: string, artist: string, apiKey?: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&artist=${
        encodeURIComponent(artist)
    }&album=${title}&api_key=${apiKey}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    const json = await req.json();
    return json;
}

export async function getTopTracks(artist: string, apiKey?: string, count = 50, mbid?: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=artist.gettoptracks&${
        mbid ? `mbid=${encodeURIComponent(mbid)}` : `artist=${encodeURIComponent(artist)}`
    }&count=${count}&api_key=${apiKey}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    const json = await req.json();
    return json.toptracks?.track.map((track: Record<string, string | number>, index: number) => {
        return { name: track.name, rank: index + 1 };
    }) || [];
}

// Temporarily housing spotify realted stuff here.

async function getSpotifyToken(database: Deno.Kv, CLIENT_ID: string, CLIENT_SECRET: string) {
    const key = ['system', 'spotifyToken'];
    const storedData = (await database.get(key)).value as { token: string; expiresAt: number };

    const now = Date.now() / 1000; // Convert to seconds

    if (storedData && now < storedData.expiresAt) {
        return storedData.token; // Use cached token if still valid
    }

    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
        },
        body: 'grant_type=client_credentials',
    });

    const data = await response.json();
    const expiresAt = now + data.expires_in; // Usually 3600 seconds

    // Store new token in Deno KV
    await database.set(key, { token: data.access_token, expiresAt });

    return data.access_token;
}

export async function getArtistCover(artistName: string, database: Deno.Kv, client_id: string, client_secret: string) {
    const token = await getSpotifyToken(database, client_id, client_secret);
    const response = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(artistName)}&type=artist&limit=1`,
        {
            headers: { Authorization: `Bearer ${token}` },
        },
    );

    const data = await response.json();
    const artist = data.artists.items[0];

    if (!artist) {
        throw new Error('Artist not found');
    }

    if (artist.images?.length) {
        const images = artist.images.sort((a: Record<string, number>, b: Record<string, number>) => a.height - b.height);

        const sizeLabels = ['small', 'medium', 'large'];

        return images.map((image: Record<string, string>, index: number) => ({
            ...image,
            size: sizeLabels[index] || 'large', // Defaults to 'large' if more than 3 images
        }));
    }

    return;
}
