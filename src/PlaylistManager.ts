// PlaylistManager.ts
import PImage from "pureimage";
import { config, database, logger } from "./util.ts";
import { CoverArt, CoverArtSchema, Playlist, PlaylistSchema, Song } from "./zod.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";
import fs from "node:fs";

const CANVAS_SIZE = 500;

/**
 * Compute average color by sampling a 1×1 downscaled JPEG.
 */
async function getAverageColor(coverArtPath: string): Promise<[number, number, number]> {
    const img = await PImage.decodeJPEGFromStream(fs.createReadStream(coverArtPath));
    const thumb = PImage.make(1, 1);
    const ctx = thumb.getContext("2d");
    ctx.drawImage(img, 0, 0, 1, 1);
    const { data } = ctx.getImageData(0, 0, 1, 1);
    return [data[0], data[1], data[2]];
}

/**
 * Draw playlist title centered, auto-sized, and word-wrapped.
 */
function drawPlaylistTitle(ctx: PImage.Context, title: string, textColor: string) {
    const maxWidth = 450, maxHeight = 450;
    let fontSize = 64;
    let lines: string[] = [];

    const wrap = (t: string): string[] => {
        const words = t.split(/\s+/);
        const out: string[] = [];
        let line = "";
        for (const w of words) {
            const test = line ? `${line} ${w}` : w;
            const { width } = ctx.measureText(test);
            if (width <= maxWidth) line = test;
            else {
                if (line) out.push(line);
                line = w;
            }
        }
        if (line) out.push(line);
        return out;
    };

    while (fontSize > 10) {
        ctx.font = `${fontSize}px Dinofiles`;
        lines = wrap(title);
        if (lines.length * fontSize * 1.2 <= maxHeight) break;
        fontSize -= 4;
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = textColor;

    const totalH = lines.length * fontSize * 1.2;
    let y = (CANVAS_SIZE - totalH) / 2 + fontSize / 2;
    for (const line of lines) {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillText(line, CANVAS_SIZE / 2 + 2, y + 2);
        ctx.fillStyle = textColor;
        ctx.fillText(line, CANVAS_SIZE / 2, y);
        y += fontSize * 1.2;
    }
}

/**
 * Generate and save cover art as PNG.
 */
export async function generatePlaylistCover(playlistId: string): Promise<string | null> {
    try {
        const playlist = (await database.get(["playlists", playlistId])).value as Playlist | null;
        if (!playlist?.entry?.length) {
            logger.error(`[Cover Art] Playlist ${playlistId} not found or empty.`);
            return null;
        }

        const firstTrackId = playlist.entry[0] as string;
        const track = (await database.get(["tracks", firstTrackId])).value as Song | null;
        if (!track?.subsonic.albumId) {
            logger.error(`[Cover Art] Track ${firstTrackId} missing albumId.`);
            return null;
        }

        const coverArtQ = (await database.get(["covers", track.subsonic.albumId])).value as CoverArt | null;
        if (!coverArtQ) {
            logger.error(`[Cover Art] Album ${track.subsonic.albumId} has no cover art.`);
            return null;
        }


        const [r, g, b] = await getAverageColor(coverArtQ.path);
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        const textColor = luminance > 128 ? "#000000" : "#ffffff";

        const img = PImage.make(CANVAS_SIZE, CANVAS_SIZE);
        const ctx = img.getContext("2d");
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        const fontPath = new URL("./client/public/Dinofiles-font.ttf", import.meta.url).pathname;
        const font = PImage.registerFont(fontPath, "Dinofiles");
        await font.load();
        drawPlaylistTitle(ctx, playlist.name, textColor);

        const coversDir = join(config.data_folder, "covers");
        await Deno.mkdir(coversDir, { recursive: true }).catch(() => { });
        const finalPath = join(coversDir, `${playlistId}.png`);

        const out = fs.createWriteStream(finalPath);
        await PImage.encodeJPEGToStream(img, out)
            .then(() => {
                out.end(); // ensure stream flushes
            })
            .catch((err) => {
                console.error("[Cover Art] PNG encode error:", err);
            });

        await new Promise<void>((resolve, reject) => {
            out.on("finish", resolve);
            out.on("error", reject);
        });

        console.log("[Cover Art] Finished writing:", finalPath);


        return finalPath;
    } catch (err) {
        logger.error(`[Cover Art] Failed to generate cover for ${playlistId}:`, err);
        return null;
    }
}

/**
 * Check and update cover art for playlist.
 */
export async function updatePlaylistCover(playlistId: string): Promise<boolean> {
    const playlistEntry = await database.get(["playlists", playlistId]);
    const playlistParse = PlaylistSchema.safeParse(playlistEntry.value);
    if (!playlistParse.success) {
        logger.warn(`[PlaylistManager] Invalid playlist ${playlistId}`);
        return false;
    }

    const playlist = playlistParse.data;
    const coverEntry = await database.get(["covers", playlist.id]);
    const coverParse = CoverArtSchema.safeParse(coverEntry.value);
    const valid = coverParse.success && await exists(coverParse.data.path);

    if (valid) return false;

    const newCoverPath = await generatePlaylistCover(playlist.id);
    if (!newCoverPath) return false;

    const newCover = CoverArtSchema.safeParse({
        id: playlist.id,
        mimeType: "image/png",
        path: newCoverPath,
    });

    if (!newCover.success) return false;
    await database.set(["covers", playlist.id], newCover.data);
    playlist.coverArt = playlist.id;
    await database.set(["playlists", playlist.id], playlist);

    logger.info(`[PlaylistManager] Generated and saved new cover for "${playlist.name}".`);
    return true;
}
