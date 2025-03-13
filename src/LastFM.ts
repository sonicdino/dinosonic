// Here houses LastFM related functions, srobbling, metadata retrieval etc.

export async function getTrackInfo(title: string, artist: string, apiKey?: string) {
    const reqUrl = `https://ws.audioscrobbler.com/2.0/?method=track.getinfo&artist=${encodeURIComponent(artist)}&track=${
        encodeURIComponent(title)
    }&api_key=${apiKey}&format=json`;
    const req = await fetch(reqUrl);
    if (!req.ok) return;
    const json = await req.json();
    console.log(json);
}

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
