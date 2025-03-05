// Here houses the recursive file scanner and metadata scanner.
import { walk } from "https://deno.land/std/fs/mod.ts";
import { IAudioMetadata, IPicture, parseFile } from 'npm:music-metadata';
import * as path from "jsr:@std/path";
import { exists, filePathToId, separatorsToRegex } from "./util.ts";
import { AlbumID3, AlbumID3Schema, ArtistID3Schema, Song, SongSchema, AlbumID3Artists, AlbumReleaseDateSchema, CoverArt, Config, ArtistID3, ReplayGainSchema } from "./zod.ts";
import { Genre } from "./zod.ts";

const seenFiles = new Set<string>();
const PLACEHOLDER_SEPARATORS = [";", ",", "/"];
const separators = PLACEHOLDER_SEPARATORS;

interface ScanStatus {
    running: boolean;
    scannedFiles: number;
    totalFiles: number;
}

let scanStatus: ScanStatus = {
    running: false,
    scannedFiles: 0,
    totalFiles: 0,
};

// TODO: Change from ArtistID3 to normal arist.
async function getArtistIDByName(database: Deno.Kv, name: string): Promise<string | undefined> {
    for await (const entry of database.list({ prefix: ["artists"] })) {
        const parsedEntry = ArtistID3Schema.safeParse(entry.value);
        if (parsedEntry.success) {
            const artist = parsedEntry.data;
            if (artist.name === name) return artist.id;
        }
    }
}

// TODO: Change from AlbumID3 to normal album.
async function getAlbumIDByName(database: Deno.Kv, name: string): Promise<string | undefined> {
    for await (const entry of database.list({ prefix: ["albums"] })) {
        const parsedEntry = AlbumID3Schema.safeParse(entry.value);
        if (parsedEntry.success) {
            const album = parsedEntry.data;
            if (album.name === name) return album.id;
        }
    }
}

async function handleCoverArt(database: Deno.Kv, id: string, pictures: IPicture[] | undefined, config: Config, filePath?: string) {
    const coverExists = (await database.get(["covers", id])).value as CoverArt | null;
    if (coverExists || !pictures?.length) return;

    const mimeToExt: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp", // webp sucks.
        "image/bmp": "bmp",
        "image/svg+xml": "svg",
    };

    const cover = pictures.find(pic => pic.type?.toLowerCase().startsWith("cover"));
    if (!cover) return;
    const coversDir = path.join(config.data_folder, "covers");
    const coversDirExists = await exists(coversDir);
    filePath = path.join(coversDir, `${id}.${mimeToExt[cover.format as string]}`);
    if (!coversDirExists) await Deno.mkdir(coversDir);
    await Deno.writeFile(filePath, cover.data);
    await database.set(["covers", id], {
        id,
        mimeType: cover.format,
        path: filePath
    })
}

async function handleAlbum(database: Deno.Kv, albumId: string, trackId: string, albumArtists: AlbumID3Artists[], metadata: IAudioMetadata) {
    const exists = (await database.get(["albums", albumId])).value as AlbumID3 | null;
    if (exists && !exists.song.includes(trackId)) {
        exists.songCount = exists.songCount + 1;
        exists.duration = Math.round(exists.duration + (metadata.format.duration || 0));
        exists.song.push(trackId);
        if (!exists.discTitles.find(disc => disc.disc === metadata.common.disk.no)) exists.discTitles.push({ disc: metadata.common.disk.no || 0, title: `Disc ${metadata.common.disk.no || 0}` })

        for await (const Artist of albumArtists) {
            const artist = (await database.get(["artists", Artist.id])).value as ArtistID3 | null;
            if (artist && !artist.album.includes(albumId)) {
                artist.album.push(albumId);
                await database.set(["artists", albumArtists[0].id], artist);
            }
        }

        return database.set(["albums", albumId], exists);
    }

    for await (const Artist of albumArtists) {
        const artist = (await database.get(["artists", Artist.id])).value as ArtistID3 | null;
        if (artist && !artist.album.includes(albumId)) {
            artist.album.push(albumId);
            await database.set(["artists", albumArtists[0].id], artist);
        }
    }

    const [year, month, day] = (metadata.common.date || "1947-2-23").split("-");
    const originalReleaseDate = AlbumReleaseDateSchema.parse({ year: parseInt(year), month: parseInt(month), day: parseInt(day) });
    const genres: Genre[] | undefined = (typeof metadata.common.genre === "string") ? (metadata.common.genre as string).split(separatorsToRegex(separators)).map((genre: string) => { return { name: genre || "" } }) : (typeof metadata.common.genre === "object") ? metadata.common.genre.map((genre: string) => { return { name: genre || "" } }) : undefined
    const album = AlbumID3Schema.parse({
        id: albumId,
        name: metadata.common.album || "Unknown Album",
        artist: albumArtists[0].name,
        year: metadata.common.year,
        coverArt: albumId,
        duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
        genre: genres?.map((genre: Genre) => genre.name).join(", "),
        genres: genres,
        created: (new Date(metadata.common.date || "1947-2-23")).toISOString(),
        artistId: albumArtists[0].id,
        songCount: 1,
        recordLabels: [{ name: "TODO: Add support for record labels" }],
        musicBrainzId: undefined,
        artists: albumArtists,
        displayArtist: albumArtists.map(artist => artist.name).join(", "),
        releaseTypes: ["album"],
        originalReleaseDate,
        releaseDate: originalReleaseDate,
        song: [trackId],
        // TODO: Disc titles.
        discTitles: [
            {
                disc: metadata.common.disk.no || 0,
                title: `Disc ${metadata.common.disk.no || 0}`
            }
        ],
    });

    return database.set(["albums", albumId], album);
}

async function handleArtist(database: Deno.Kv, artist: string) {
    const unsorted = artist.split(separatorsToRegex(separators));
    const sorted = [];
    for (const artist of unsorted) {
        const name = artist.trim();
        const id = await getArtistIDByName(database, name) || await getNextId(database, "A");

        const artistExists = await database.get(["artists", id]);
        if (!artistExists.value) {
            // TODO: Logging
            const Artist = ArtistID3Schema.parse({ id, name });
            await database.set(["artists", id], Artist);
        }

        sorted.push({ id, name });
    };

    return sorted;
}

async function getNextId(database: Deno.Kv, type: "t" | "a" | "A" | "c"): Promise<string> {
    const idKey = ["counters", type];
    const lastId = (await database.get(idKey)).value as number || 0;
    const newId = lastId + 1;
    await database.set(idKey, newId);
    return `${type}${newId}`;
}

export async function scanMediaDirectories(
    database: Deno.Kv,
    directories: string[],
    config: Config
) {
    if (scanStatus.running) {
        console.log("Scan already in progress.");
        return;
    }

    scanStatus = { running: true, scannedFiles: 0, totalFiles: 0 };

    for (const dir of directories) {
        console.log(`🔍 Scanning directory: ${dir}`);
        await scanDirectory(database, dir, config);
    }

    scanStatus.running = false;
    console.log("✅ Media scan complete.");
}

async function scanDirectory(database: Deno.Kv, dir: string, config: Config) {
    for await (const _entry of walk(dir, { exts: [".flac", ".mp3", ".wav", ".ogg"] })) {
        scanStatus.totalFiles++;
    }

    for await (const entry of walk(dir, { exts: [".flac", ".mp3", ".wav", ".ogg"] })) {
        const filePath = entry.path;
        seenFiles.add(filePath);
        if (!filePath.startsWith("/home/rapid/Music/media/music/Bruno Mars/")) continue;
        await processMediaFile(database, entry.path, config);
        scanStatus.scannedFiles++;
    }

    for await (const entry of database.list({ prefix: ["filePathToId"] })) {
        const filePath = entry.key[1] as string;
        if (!seenFiles.has(filePath)) {
            const trackId = entry.value as string;
            await database.delete(["tracks", trackId]);
            await database.delete(entry.key);
            console.log(`Removed: ${trackId}`);
        }
    }
}

async function processMediaFile(database: Deno.Kv, filePath: string, config: Config) {
    const fileId = filePathToId(filePath);
    const existing = await database.get(["tracks", fileId]);

    const metadata = await extractMetadata(filePath, database, config);
    if (!metadata) return;

    if (!existing.value || (existing.value as Song).backend.lastModified !== metadata.backend.lastModified) {
        console.log(`📀 Updating metadata for ${filePath}`);
        await database.set(["tracks", fileId], metadata);
    }
}
async function extractMetadata(filePath: string, database: Deno.Kv, config: Config) {
    try {
        const metadata = await parseFile(filePath);
        let trackId = (await database.get(["filePathToId", filePath])).value as string | null;

        if (!trackId) {
            trackId = await getNextId(database, "t");
            await database.set(["filePathToId", filePath], trackId);
        }

        const album = metadata.common.album || "Unknown Album";
        const albumId = await getAlbumIDByName(database, album) || await getNextId(database, "a");

        const coverId = albumId;
        await handleCoverArt(database, coverId, metadata.common.picture, config);

        const artists = await handleArtist(database, metadata.common.artist || "Unknown Artist");
        const albumArtists = await handleArtist(database, metadata.common.albumartist || "Unknown Artist");
        await handleAlbum(database, albumId, trackId, albumArtists, metadata);

        const genres: Genre[] | undefined = (typeof metadata.common.genre === "string") ? (metadata.common.genre as string).split(separatorsToRegex(separators)).map((genre: string) => { return { name: genre || "" } }) : (typeof metadata.common.genre === "object") ? metadata.common.genre.map((genre: string) => { return { name: genre || "" } }) : undefined
        const replayGain = ReplayGainSchema.parse({
            trackGain: metadata.common.replaygain_track_gain?.dB,
            trackPeak: metadata.common.replaygain_track_peak?.dB,
            albumGain: metadata.common.replaygain_track_gain?.dB,
            albumPeak: metadata.common.replaygain_album_peak?.dB,
        })

        const contentType: Record<string, string> = {
            "flac": "audio/flac",
            "mp3": "audio/mpeg",
            "wav": "aduio/wav",
            "ogg": "audio/ogg"
        }

        const songMetadata = SongSchema.parse({
            backend: {
                lastModified: (await Deno.stat(filePath)).mtime?.getTime() ?? Date.now(),
            },
            subsonic: {
                id: trackId,
                title: metadata.common.title || "Unknown Title",
                album: album,
                artist: artists[0].name,
                track: metadata.common.track.no,
                year: metadata.common.year,
                genre: genres?.map((genre: Genre) => genre.name).join(", "),
                coverArt: albumId, // Cover extraction not handled here
                size: BigInt((await Deno.stat(filePath)).size),
                contentType: contentType[(filePath.split(".").pop() || "mp3").toLowerCase()],
                suffix: (filePath.split(".").pop() || "mp3").toLowerCase(),
                duration: Math.round(metadata.format.duration || 0),
                bitRate: Math.round((metadata.format.bitrate || 1) / 1000),
                bitDepth: metadata.format.bitsPerSample,
                samplingRate: metadata.format.sampleRate,
                channelCount: metadata.format.numberOfChannels,
                path: filePath,
                isVideo: false,
                playCount: BigInt(0),
                discNumber: metadata.common.disk.no,
                created: new Date().toISOString(),
                albumId,
                artistId: crypto.randomUUID(),
                type: "music",
                musicBrainzId: metadata.common.musicbrainz_trackid,
                genres: genres,
                artists,
                albumArtists,
                displayAlbumArtist: artists.map(artist => artist.name).join(", "),
                replayGain
            },
        });

        return songMetadata
    } catch (error) {
        console.error(`❌ Failed to extract metadata for ${filePath}:`, error);
        return null;
    }
}

export function getScanStatus() {
    return scanStatus;
}
