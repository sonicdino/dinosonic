import { Image, TextLayout } from "@matmen/imagescript";
import { config, database, logger } from "./util.ts";
import { CoverArt, CoverArtSchema, Playlist, PlaylistSchema, Song } from './zod.ts';
import { join } from '@std/path';
import { exists } from '@std/fs';

/**
 * Renders the playlist title onto the canvas, automatically handling wrapping and font-size adjustment.
 */
function drawPlaylistTitle(canvas: Image, title: string, font: Uint8Array, textColor: number) {
    const maxWidth = 450;
    const maxHeight = 450;
    let fontSize = 64;

    let finalTextImage: Image | null = null;

    while (fontSize > 10) {
        const layout = new TextLayout({ maxWidth: maxWidth, wrapStyle: 'word' });
        const renderedText = Image.renderText(font, fontSize, title, textColor, layout);

        if (renderedText.height <= maxHeight) {
            finalTextImage = renderedText;
            break;
        }
        fontSize -= 4;
    }

    if (!finalTextImage) {
        const layout = new TextLayout({ maxWidth: maxWidth, wrapStyle: 'word' });
        finalTextImage = Image.renderText(font, 10, title, textColor, layout);
    }

    const x = (canvas.width - finalTextImage.width) / 2;
    const y = (canvas.height - finalTextImage.height) / 2;
    canvas.composite(finalTextImage, x, y);
}

/**
 * Main function to generate and save a playlist cover art.
 * It creates a blurred background from the first song's album art and overlays the playlist title.
 * @param playlistId The ID of the playlist to generate a cover for.
 * @returns The relative path for the DB (e.g., "playlist/123.jpg") or null if it failed.
 */
export async function generatePlaylistCover(playlistId: string): Promise<string | null> {
    try {
        const playlist = (await database.get(["playlists", playlistId])).value as Playlist | null;
        if (!playlist?.entry || playlist.entry.length === 0) {
            console.error(`[Cover Art] Playlist ${playlistId} not found or is empty.`);
            return null;
        }

        const firstTrackId = playlist.entry[0] as string;
        const track = (await database.get(["tracks", firstTrackId])).value as Song | null;
        if (!track?.subsonic.albumId) {
            console.error(`[Cover Art] Track ${firstTrackId} or its albumId not found.`);
            return null;
        }

        const coverArtQ = (await database.get(["covers", track.subsonic.albumId])).value as CoverArt | null;
        if (!coverArtQ) {
            console.error(`[Cover Art] Album ${track.subsonic.albumId} has no cover art specified.`);
            return null;
        }

        const coverArtPath = coverArtQ.path;

        const coverArtData = await Deno.readFile(coverArtPath);
        const coverArt = await Image.decode(coverArtData);

        coverArt.resize(1, 1);
        const averageColor = coverArt.getPixelAt(1, 1);

        const [r, g, b] = Image.colorToRGBA(averageColor);
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b);

        // If luminance > 128, the background is light, so use black text. Otherwise, use white text.
        // Colors are in RGBA format (0xRRGGBBAA)
        const textColor = luminance > 128 ? 0x000000FF : 0xFFFFFFFF;

        const canvas = new Image(500, 500);
        canvas.fill(averageColor);

        const font = await Deno.readFile("./src/client/public/Dinofiles-font.ttf");
        await drawPlaylistTitle(canvas, playlist.name, font, textColor);

        const finalImage = await canvas.encode(0.8);
        const coversDir = join(config.data_folder, 'covers');
        await Deno.mkdir(coversDir, { recursive: true }).catch(() => { });

        const finalFilename = `${playlistId}.jpg`;
        const finalPath = join(coversDir, finalFilename);

        await Deno.writeFile(finalPath, finalImage);

        return finalPath;

    } catch (error) {
        console.error(`[Cover Art] A critical error occurred while generating cover for playlist ${playlistId}:`, error);
        return null;
    }
}

/**
 * A centralized function to check and update the cover art for a specific playlist.
 * This should be called whenever a playlist is created or its contents/name change.
 *
 * @param playlistId The ID of the playlist to check.
 * @returns true if changes were made, false otherwise.
 */
export async function updatePlaylistCover(playlistId: string): Promise<boolean> {
    const playlistEntry = await database.get(["playlists", playlistId]);
    const playlistParse = PlaylistSchema.safeParse(playlistEntry.value);

    if (!playlistParse.success) {
        logger.warn(`[PlaylistManager] Could not find or parse playlist with ID: ${playlistId}`);
        return false;
    }

    const playlist = playlistParse.data;
    let coverExistsAndIsValid = false;

    const coverEntry = await database.get(["covers", playlist.id]);
    const coverParse = CoverArtSchema.safeParse(coverEntry.value);
    if (coverParse.success && await exists(coverParse.data.path)) {
        coverExistsAndIsValid = true;
    } else {
        logger.warn(`[PlaylistManager] Playlist ${playlist.id} has cover ID ${playlist.id}, but the file is missing or invalid. Will regenerate.`);
    }

    if (!coverExistsAndIsValid) {
        const newCoverPath = await generatePlaylistCover(playlist.id);

        if (newCoverPath) {
            const newCover = CoverArtSchema.safeParse({
                id: playlist.id,
                mimeType: 'image/jpeg',
                path: newCoverPath,
            });

            if (newCover.success) {
                await database.set(['covers', playlist.id], newCover.data);
                playlist.coverArt = playlist.id;
                await database.set(['playlists', playlist.id], playlist);
                logger.info(`[PlaylistManager] Generated and saved new cover for playlist "${playlist.name}".`);
                return true;
            }
        }
    }

    return false;
}