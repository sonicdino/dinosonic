// Artist and album creation/update logic
import { config, database, generateId, logger, separatorsToRegex } from '../util.ts';
import { AlbumID3Artists, AlbumReleaseDateSchema, AlbumSchema, Artist, ArtistID3Schema, ArtistSchema, Song } from '../zod.ts';
import { DatabaseRepository } from './DatabaseRepository.ts';

const dbRepo = new DatabaseRepository();

export async function handleArtists(artistString: string, artistArray: string[] = []): Promise<AlbumID3Artists[]> {
    const allSources: string[] = [];

    if (artistString && artistString !== 'Unknown Artist') {
        allSources.push(artistString);
    }
    if (artistArray.length) {
        allSources.push(...artistArray);
    }

    const unsortedNames = allSources
        .flatMap((source) => source.split(separatorsToRegex(config.artist_separators)))
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

    const uniqueNames = [...new Set(unsortedNames)];
    const sortedArtists: AlbumID3Artists[] = [];

    for (const name of uniqueNames) {
        const trimmedName = name.trim();
        if (!trimmedName) continue;

        let id = await dbRepo.getArtistIdByName(trimmedName);
        let artistData: Artist | null = null;

        if (id) {
            const artistEntry = await database.get(['artists', id]);
            const parseResult = ArtistSchema.safeParse(artistEntry.value);
            if (parseResult.success) {
                artistData = parseResult.data;
            }
        }

        if (!artistData) {
            id = await generateId();
            const newArtistArtistPart = ArtistID3Schema.safeParse({
                id,
                name: trimmedName,
                coverArt: id,
                albumCount: 0,
                album: [],
            });

            if (newArtistArtistPart.success) {
                const newArtistFull = ArtistSchema.safeParse({
                    artist: newArtistArtistPart.data,
                    lastFM: false,
                });

                if (newArtistFull.success) {
                    await database.set(['artists', id], newArtistFull.data);
                    artistData = newArtistFull.data;
                    logger.debug(`Created new artist: ${trimmedName} (${id})`);
                } else {
                    logger.error(`Failed to validate new artist ${trimmedName}: ${JSON.stringify(newArtistFull.error.issues)}`);
                }
            } else {
                logger.error(`Failed to validate artist part ${trimmedName}: ${JSON.stringify(newArtistArtistPart.error.issues)}`);
            }
        }

        if (artistData) {
            sortedArtists.push({ id: artistData.artist.id, name: artistData.artist.name });
        }
    }

    return sortedArtists;
}

// deno-lint-ignore no-explicit-any
export async function handleAlbum(albumId: string, trackId: string, albumArtists: AlbumID3Artists[], metadata: any) {
    const albumEntry = await database.get(['albums', albumId]);
    const existingAlbumParse = AlbumSchema.safeParse(albumEntry.value);
    const existingAlbum = existingAlbumParse.success ? existingAlbumParse.data : null;

    if (existingAlbum) {
        let changes = false;
        const songSet = new Set(
            existingAlbum.subsonic.song.map((s) => typeof s === 'string' ? s : (s as Song).subsonic?.id || (s as { id: string }).id).filter(Boolean),
        );

        if (!songSet.has(trackId)) {
            existingAlbum.subsonic.song.push(trackId);
            existingAlbum.subsonic.songCount = existingAlbum.subsonic.song.length;
            existingAlbum.subsonic.duration = Math.round(
                existingAlbum.subsonic.duration + (metadata.audioInfo.duration || 0),
            );
            changes = true;
        }

        if (!existingAlbum.subsonic.discTitles.find((disc) => disc.disc === metadata.tags.discNumber)) {
            existingAlbum.subsonic.discTitles.push({
                disc: metadata.tags.discNumber,
                title: `Disc ${metadata.tags.discNumber}`,
            });
            changes = true;
        }

        for (const newArtist of albumArtists) {
            if (!existingAlbum.subsonic.artists.some((a) => a.id === newArtist.id)) {
                existingAlbum.subsonic.artists.push(newArtist);
                changes = true;
            }
        }

        for (const currentAlbumArtist of existingAlbum.subsonic.artists) {
            const artistEntry = await database.get(['artists', currentAlbumArtist.id]);
            const artistParse = ArtistSchema.safeParse(artistEntry.value);

            if (artistParse.success) {
                const artist = artistParse.data;
                if (!artist.artist.album.includes(albumId)) {
                    artist.artist.album.push(albumId);
                    artist.artist.albumCount = artist.artist.album.length;
                    await database.set(['artists', artist.artist.id], artist);
                }
            }
        }

        if (changes) {
            existingAlbum.subsonic.displayArtist = formatDisplayArtist(existingAlbum.subsonic.artists);
            const validatedAlbum = AlbumSchema.safeParse(existingAlbum);

            if (validatedAlbum.success) {
                await database.set(['albums', albumId], validatedAlbum.data);
                logger.debug(`Updated album: ${existingAlbum.subsonic.name}`);
            } else {
                logger.error(`Error re-validating album ${albumId}: ${JSON.stringify(validatedAlbum.error.issues)}`);
            }
        }

        return;
    }

    const [yearStr = '1970', monthStr = '1', dayStr = '1'] = (
        metadata.tags.date ||
        metadata.tags.originalYear?.toString() ||
        '1970-1-1'
    ).split('-');

    const releaseDate = AlbumReleaseDateSchema.safeParse({
        year: parseInt(yearStr),
        month: parseInt(monthStr),
        day: parseInt(dayStr),
    });

    const newAlbumData = {
        backend: { dateAdded: Date.now(), lastFM: false },
        subsonic: {
            id: albumId,
            name: metadata.tags.album,
            artist: albumArtists[0]?.name || 'Unknown Artist',
            year: metadata.tags.year || (releaseDate.success ? releaseDate.data.year : undefined),
            coverArt: albumId,
            duration: metadata.audioInfo.duration || 0,
            genre: metadata.tags.genreString,
            genres: metadata.tags.genres,
            created: new Date(
                metadata.tags.date ||
                    (releaseDate.success ? `${releaseDate.data.year}-${releaseDate.data.month}-${releaseDate.data.day}` : '1970-01-01'),
            ).toISOString(),
            artistId: albumArtists[0]?.id,
            songCount: 1,
            artists: albumArtists,
            displayArtist: formatDisplayArtist(albumArtists),
            releaseTypes: metadata.tags.releaseType ? [metadata.tags.releaseType.join('/')] : ['album'],
            originalReleaseDate: releaseDate.success ? releaseDate.data : undefined,
            releaseDate: releaseDate.success ? releaseDate.data : undefined,
            song: [trackId],
            discTitles: [{
                disc: metadata.tags.discNumber,
                title: `Disc ${metadata.tags.discNumber}`,
            }],
            musicBrainzId: metadata.tags.musicBrainzAlbumId,
        },
    };

    const albumParseResult = AlbumSchema.safeParse(newAlbumData);

    if (albumParseResult.success) {
        await database.set(['albums', albumId], albumParseResult.data);
        logger.info(`Created new album: ${metadata.tags.album}`);

        for (const artist of albumArtists) {
            const artistEntry = await database.get(['artists', artist.id]);
            const artistParse = ArtistSchema.safeParse(artistEntry.value);

            if (artistParse.success) {
                const artistData = artistParse.data;
                if (!artistData.artist.album.includes(albumId)) {
                    artistData.artist.album.push(albumId);
                    artistData.artist.albumCount = artistData.artist.album.length;
                    await database.set(['artists', artist.id], artistData);
                }
            }
        }
    } else {
        logger.error(`Failed to validate new album ${metadata.tags.album}: ${JSON.stringify(albumParseResult.error.issues)}`);
    }
}

function formatDisplayArtist(artists: AlbumID3Artists[]): string {
    if (artists.length === 0) return 'Unknown Artist';
    if (artists.length === 1) return artists[0].name;

    return artists.slice(0, -1).map((a) => a.name).join(', ') +
        ' & ' +
        artists[artists.length - 1].name;
}
