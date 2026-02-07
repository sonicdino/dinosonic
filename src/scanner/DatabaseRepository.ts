import { database } from '../util.ts';
import { Album, AlbumSchema, Artist, ArtistSchema, CoverArtSchema, ShareSchema, Song, SongSchema } from '../zod.ts';

export class DatabaseRepository {
    private artistCache = new Map<string, string>();
    private albumCache = new Map<string, string>();

    clearCaches() {
        this.artistCache.clear();
        this.albumCache.clear();
    }

    async batchDelete(keys: Deno.KvKey[]): Promise<void> {
        const BATCH_SIZE = 100;
        for (let i = 0; i < keys.length; i += BATCH_SIZE) {
            const batch = keys.slice(i, i + BATCH_SIZE);
            const txn = database.atomic();
            for (const key of batch) {
                txn.delete(key);
            }
            await txn.commit();
        }
    }

    async getArtistIdByName(name: string): Promise<string | undefined> {
        const normalizedName = name.toLowerCase().trim();

        if (this.artistCache.has(normalizedName)) {
            return this.artistCache.get(normalizedName);
        }

        for await (const entry of database.list({ prefix: ['artists'] })) {
            const artistParseResult = ArtistSchema.safeParse(entry.value);
            if (
                artistParseResult.success &&
                artistParseResult.data.artist.name.toLowerCase().trim() === normalizedName
            ) {
                const id = artistParseResult.data.artist.id;
                this.artistCache.set(normalizedName, id);
                return id;
            }
        }

        return undefined;
    }

    async getAlbumIdByName(name: string, artists?: Array<{ id: string; name: string }>): Promise<string | undefined> {
        const normalizedName = name.toLowerCase().trim();
        const cacheKey = artists?.length ? `${normalizedName}|${artists.map((a) => a.name.toLowerCase().trim()).sort().join('|')}` : normalizedName;

        if (this.albumCache.has(cacheKey)) {
            return this.albumCache.get(cacheKey);
        }

        for await (const { value } of database.list({ prefix: ['albums'] })) {
            const parsedEntry = AlbumSchema.safeParse(value);
            if (!parsedEntry.success || parsedEntry.data.subsonic.name.toLowerCase().trim() !== normalizedName) {
                continue;
            }

            if (
                !artists?.length ||
                parsedEntry.data.subsonic.artists.some((albumArtist) =>
                    artists.some((a) => a.name.toLowerCase().trim() === albumArtist.name.toLowerCase().trim())
                )
            ) {
                const id = parsedEntry.data.subsonic.id;
                this.albumCache.set(cacheKey, id);
                return id;
            }
        }

        return undefined;
    }

    async *getAllTracks(): AsyncGenerator<{ id: string; track: Song; path: string }> {
        for await (const trackEntry of database.list({ prefix: ['tracks'] })) {
            const trackId = trackEntry.key[1] as string;
            const trackResult = SongSchema.safeParse(trackEntry.value);

            if (trackResult.success) {
                yield {
                    id: trackId,
                    track: trackResult.data,
                    path: trackResult.data.subsonic.path,
                };
            }
        }
    }

    async *getAllAlbums(): AsyncGenerator<{ id: string; album: Album }> {
        for await (const albumEntry of database.list({ prefix: ['albums'] })) {
            const albumId = albumEntry.key[1] as string;
            const albumResult = AlbumSchema.safeParse(albumEntry.value);

            if (albumResult.success) {
                yield { id: albumId, album: albumResult.data };
            }
        }
    }

    async *getAllArtists(): AsyncGenerator<{ id: string; artist: Artist }> {
        for await (const artistEntry of database.list({ prefix: ['artists'] })) {
            const artistId = artistEntry.key[1] as string;
            const artistResult = ArtistSchema.safeParse(artistEntry.value);

            if (artistResult.success) {
                yield { id: artistId, artist: artistResult.data };
            }
        }
    }

    async findOrCreateCoverArtShare(coverArtId: string, userId: string, description: string): Promise<string | null> {
        for await (const entry of database.list({ prefix: ['shares'] })) {
            const shareResult = ShareSchema.safeParse(entry.value);
            if (
                shareResult.success &&
                shareResult.data.itemType === 'coverArt' &&
                shareResult.data.itemId === coverArtId &&
                shareResult.data.description === description &&
                shareResult.data.userId === userId
            ) {
                return shareResult.data.id;
            }
        }

        const { generateId } = await import('../util.ts');
        const shareId = await generateId(12);
        const newShareData = {
            id: shareId,
            userId: userId,
            itemId: coverArtId,
            itemType: 'coverArt' as const,
            description: description,
            created: new Date(),
            expires: null,
            viewCount: 0,
        };

        const newShare = ShareSchema.safeParse(newShareData);
        if (newShare.success) {
            await database.set(['shares', shareId], newShare.data);
            return shareId;
        }

        return null;
    }

    async coverArtExists(itemId: string): Promise<boolean> {
        const existingCoverEntry = await database.get(['covers', itemId]);
        if (!existingCoverEntry.value) return false;

        const parsedExisting = CoverArtSchema.safeParse(existingCoverEntry.value);
        if (!parsedExisting.success) return false;

        const { exists } = await import('@std/fs/exists');
        return await exists(parsedExisting.data.path);
    }

    async getTrackIdByPath(filePath: string): Promise<string | null> {
        const entry = await database.get(['filePathToId', filePath]);
        return entry.value as string | null;
    }

    async setTrackIdForPath(filePath: string, trackId: string): Promise<void> {
        await database.set(['filePathToId', filePath], trackId);
    }
}
