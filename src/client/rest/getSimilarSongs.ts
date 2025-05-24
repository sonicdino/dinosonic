import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, validateAuth, logger } from '../../util.ts';
import { AlbumSchema, ArtistSchema, Song, SongID3, SongSchema, userData } from '../../zod.ts';

const getSimilarSongs = new Hono();

async function handlegetSimilarSongs(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const count = parseInt(await getField(c, 'count') || '50');
    const inputId = await getField(c, 'id') || '';

    if (!inputId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const seedSongs: SongID3[] = [];
    let itemType: 'song' | 'album' | 'artist' | null = null;
    let seedItemId: string = inputId;

    const songEntry = await database.get(['tracks', inputId]);
    if (songEntry.value) {
        const parsedSong = SongSchema.safeParse(songEntry.value);
        if (parsedSong.success) {
            seedSongs.push(await enrichSongWithUserData(parsedSong.data.subsonic, user.backend.id));
            itemType = 'song';
        }
    } else {
        const albumEntry = await database.get(['albums', inputId]);
        if (albumEntry.value) {
            const parsedAlbum = AlbumSchema.safeParse(albumEntry.value);
            if (parsedAlbum.success) {
                itemType = 'album';
                seedItemId = parsedAlbum.data.subsonic.id;
                const album = parsedAlbum.data;
                logger.debug(`Finding similar songs for album: ${album.subsonic.name} (ID: ${seedItemId})`);
                for (const songIdOrObj of album.subsonic.song) {
                    const songId = typeof songIdOrObj === 'string' ? songIdOrObj : (songIdOrObj as SongID3).id;
                    const trackEntry = await database.get(['tracks', songId]);
                    if (trackEntry.value) {
                        const songData = SongSchema.safeParse(trackEntry.value);
                        if (songData.success) seedSongs.push(await enrichSongWithUserData(songData.data.subsonic, user.backend.id));
                    }
                    if (seedSongs.length >= 5) break;
                }
                if (seedSongs.length === 0) {
                    logger.warn(`Album ${album.subsonic.name} has no valid/parsable songs to use as seed.`);
                }
            }
        } else {
            const artistEntry = await database.get(['artists', inputId]);
            if (artistEntry.value) {
                const parsedArtist = ArtistSchema.safeParse(artistEntry.value);
                if (parsedArtist.success) {
                    itemType = 'artist';
                    seedItemId = parsedArtist.data.artist.id;
                    const artist = parsedArtist.data;
                    logger.debug(`Finding similar songs for artist: ${artist.artist.name} (ID: ${seedItemId})`);
                    let artistSongCount = 0;
                    for await (const trackEntryIterator of database.list({ prefix: ['tracks'] })) {
                        const songData = SongSchema.safeParse(trackEntryIterator.value);
                        if (songData.success && songData.data.subsonic.artists.some(a => a.id === artist.artist.id)) {
                            seedSongs.push(await enrichSongWithUserData(songData.data.subsonic, user.backend.id));
                            artistSongCount++;
                            if (artistSongCount >= 5) break;
                        }
                    }
                    if (seedSongs.length === 0) {
                        logger.warn(`Artist ${artist.artist.name} has no songs in the library to use as seed.`);
                    }
                }
            }
        }
    }

    if (seedSongs.length === 0) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Could not find a valid song, album, or artist for the given ID to seed similar songs.' });
    }

    logger.debug(`Using ${seedSongs.length} seed song(s). First seed: ${seedSongs[0].title}, Type: ${itemType}, ID: ${seedItemId}`);

    const allLibrarySongs: Song[] = [];
    for await (const entry of database.list({ prefix: ['tracks'] })) {
        const parsed = SongSchema.safeParse(entry.value);
        if (parsed.success) allLibrarySongs.push(parsed.data);
    }

    const scoredSongs = await Promise.all(
        allLibrarySongs
            .filter(candidateSongFull =>
                !seedSongs.some(seed => seed.id === candidateSongFull.subsonic.id) &&
                (itemType !== 'album' || candidateSongFull.subsonic.albumId !== seedItemId) &&
                (itemType !== 'artist' || !candidateSongFull.subsonic.artists.some(a => a.id === seedItemId))
            )
            .map(async (candidateSongFull) => {
                const candidateSong = await enrichSongWithUserData(candidateSongFull.subsonic, user.backend.id);
                let maxScore = 0;
                for (const seed of seedSongs) {
                    const currentScore = calculateSimilarity(seed, candidateSong, itemType, seedItemId);
                    if (currentScore > maxScore) {
                        maxScore = currentScore;
                    }
                }
                return { song: candidateSong, score: maxScore };
            })
    );

    const relatedButNotSeedSongs: { song: SongID3, score: number }[] = [];
    if (itemType === 'album') {
        const albumEntry = await database.get(['albums', seedItemId]);
        if (albumEntry.value) {
            const album = AlbumSchema.parse(albumEntry.value).subsonic;
            // Only take one song from the same album to encourage diversity
            for (const songIdOrObj of album.song) {
                const songId = typeof songIdOrObj === 'string' ? songIdOrObj : (songIdOrObj as SongID3).id;
                if (!seedSongs.some(s => s.id === songId)) {
                    const trackEntry = await database.get(['tracks', songId]);
                    if (trackEntry.value) {
                        const songData = SongSchema.parse(trackEntry.value);
                        relatedButNotSeedSongs.push({ song: await enrichSongWithUserData(songData.subsonic, user.backend.id), score: 60 }); // Moderate score for same album
                        break; // Only add one song from the same album
                    }
                }
            }
        }
    } else if (itemType === 'artist') {
        // Only take one song from the same artist to encourage diversity
        for await (const trackEntryIterator of database.list({ prefix: ['tracks'] })) {
            const songParseResult = SongSchema.safeParse(trackEntryIterator.value);
            if (songParseResult.success) {
                const songData = songParseResult.data;
                if (songData.subsonic.artists.some(a => a.id === seedItemId) && !seedSongs.some(s => s.id === songData.subsonic.id)) {
                    relatedButNotSeedSongs.push({ song: await enrichSongWithUserData(songData.subsonic, user.backend.id), score: 50 }); // Moderate score for same artist
                    break; // Only add one song from the same artist
                }
            }
        }
    }

    const combinedScoredSongs = [...relatedButNotSeedSongs, ...scoredSongs.filter(item => item.score > 0)];
    const finalRankedSongs = combinedScoredSongs
        .sort((a, b) => b.score - a.score)
        .map(item => item.song);

    const uniqueSongs: SongID3[] = [];
    const seenIds = new Set<string>();
    for (const song of finalRankedSongs) {
        if (!seenIds.has(song.id)) {
            uniqueSongs.push(song);
            seenIds.add(song.id);
        }
    }

    const shuffledResult = shuffleArray(uniqueSongs.slice(0, count));

    return createResponse(c, {
        [/(getSimilarSongs2|getSimilarSongs2\.view)$/.test(c.req.path) ? 'similarSongs2' : 'similarSongs']: {
            song: shuffledResult,
        },
    }, 'ok');
}

async function enrichSongWithUserData(song: SongID3, userId: string): Promise<SongID3> {
    const userTrackData = ((await database.get(['userData', userId, 'track', song.id])).value as userData) || {};
    return {
        ...song,
        starred: userTrackData.starred ? userTrackData.starred.toISOString() : undefined,
        playCount: userTrackData.playCount,
        userRating: userTrackData.userRating,
    };
}

function shuffleArray<T>(array: T[]): T[] {
    return array
        .map((item) => ({ item, rand: Math.random() })) // Assign random values
        .sort((a, b) => a.rand - b.rand) // Sort by random values
        .map(({ item }) => item); // Extract items
}

function calculateSimilarity(
    baseSong: SongID3,
    candidate: SongID3,
    seedType: 'song' | 'album' | 'artist' | null,
    seedItemId: string
): number {
    let score = 0;

    // Genre matching - keep this high as it's important for musical coherence
    if (baseSong.genre && candidate.genre && baseSong.genre.toLowerCase() === candidate.genre.toLowerCase()) {
        score += 20;
    } else if (baseSong.genres && candidate.genres && baseSong.genres.some(g1 => candidate.genres!.some(g2 => g1.name.toLowerCase() === g2.name.toLowerCase()))) {
        score += 15;
    }

    // Artist matching - significantly reduced to encourage diversity
    const baseArtistIds = new Set(baseSong.artists.map(a => a.id));
    const candidateArtistIds = new Set(candidate.artists.map(a => a.id));
    const commonArtists = [...baseArtistIds].filter(id => candidateArtistIds.has(id));

    if (commonArtists.length > 0) {
        score += 8; // Reduced from 25 to 8
        if (commonArtists.length === baseArtistIds.size && baseArtistIds.size > 0) {
            score += 4; // Reduced from 10 to 4
        }
        // Seed-specific artist boost - reduced but still present for seed context
        if (seedType === 'artist' && candidateArtistIds.has(seedItemId)) {
            score += 6; // Reduced from 30 to 6
        }
    }

    // Album matching - significantly reduced to encourage cross-album exploration
    if (baseSong.albumId && candidate.albumId === baseSong.albumId) {
        score += 4; // Reduced from 15 to 4
        // Seed-specific album boost - drastically reduced
        if (seedType === 'album' && candidate.albumId === seedItemId) {
            score += 8; // Reduced from 50 to 8
        }
    }

    // Year proximity - slightly increased to compensate for reduced artist/album weights
    if (baseSong.year && candidate.year) {
        const yearDiff = Math.abs(baseSong.year - candidate.year);
        if (yearDiff <= 2) score += 12; // Increased from 10
        else if (yearDiff <= 5) score += 8; // Increased from 6
        else if (yearDiff <= 10) score += 4; // Increased from 3
    }

    // User preference factors - slightly boosted to maintain quality
    if (baseSong.starred && candidate.starred) score += 15; // Increased from 12
    if (baseSong.userRating && candidate.userRating) {
        if (baseSong.userRating >= 4 && candidate.userRating >= 4) score += 15; // Increased from 12
        else if (Math.abs(baseSong.userRating - candidate.userRating) <= 1) score += 8; // Increased from 6
    }

    // Play count factor - slightly increased
    if (baseSong.playCount && candidate.playCount) {
        const avgPlayCount = (baseSong.playCount + candidate.playCount) / 2;
        if (avgPlayCount > 10) score += 6; // Increased from 5
        if (avgPlayCount > 30) score += 6; // Increased from 5
        if (avgPlayCount < 10) score += 1;
    }

    return score;
}

getSimilarSongs.get('/getSimilarSongs', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs', handlegetSimilarSongs);
getSimilarSongs.get('/getSimilarSongs.view', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs.view', handlegetSimilarSongs);

getSimilarSongs.get('/getSimilarSongs2', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs2', handlegetSimilarSongs);
getSimilarSongs.get('/getSimilarSongs2.view', handlegetSimilarSongs);
getSimilarSongs.post('/getSimilarSongs2.view', handlegetSimilarSongs);

export default getSimilarSongs;