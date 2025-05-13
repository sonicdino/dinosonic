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

    if (!artist) return [];

    if (artist.images?.length) {
        const images = artist.images.sort((a: Record<string, number>, b: Record<string, number>) => a.height - b.height);

        const sizeLabels = ['small', 'medium', 'large'];

        return images.map((image: Record<string, string>, index: number) => ({
            ...image,
            size: sizeLabels[index] || 'large', // Defaults to 'large' if more than 3 images
        }));
    }

    return [];
}
