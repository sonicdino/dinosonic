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
            for (const songIdOrObj of album.song) {
                const songId = typeof songIdOrObj === 'string' ? songIdOrObj : (songIdOrObj as SongID3).id;
                if (!seedSongs.some(s => s.id === songId)) {
                    const trackEntry = await database.get(['tracks', songId]);
                    if (trackEntry.value) {
                        const songData = SongSchema.parse(trackEntry.value);
                        relatedButNotSeedSongs.push({ song: await enrichSongWithUserData(songData.subsonic, user.backend.id), score: 60 });
                        break;
                    }
                }
            }
        }
    } else if (itemType === 'artist') {
        for await (const trackEntryIterator of database.list({ prefix: ['tracks'] })) {
            const songParseResult = SongSchema.safeParse(trackEntryIterator.value);
            if (songParseResult.success) {
                const songData = songParseResult.data;
                if (songData.subsonic.artists.some(a => a.id === seedItemId) && !seedSongs.some(s => s.id === songData.subsonic.id)) {
                    relatedButNotSeedSongs.push({ song: await enrichSongWithUserData(songData.subsonic, user.backend.id), score: 50 });
                    break;
                }
            }
        }
    }

    const combinedScoredSongs = [...relatedButNotSeedSongs, ...scoredSongs.filter(item => item.score > 0)];

    // Apply diversity-aware selection instead of simple sorting
    const diverseSelection = selectDiverseSongs(combinedScoredSongs, count * 2); // Get more candidates
    const finalSelection = diverseSelection.slice(0, count);
    const shuffledResult = shuffleArray(finalSelection);

    return createResponse(c, {
        [/(getSimilarSongs2|getSimilarSongs2\.view)$/.test(c.req.path) ? 'similarSongs2' : 'similarSongs']: {
            song: shuffledResult,
        },
    }, 'ok');
}

/**
 * Selects songs with enforced diversity constraints
 * Limits how many songs per artist/album can appear in the final list
 * Demoing this approach to improve variety in similar songs. Testing this in PROD Environment. Might go back to simpler method later if not good.
 */
function selectDiverseSongs(
    scoredSongs: { song: SongID3, score: number }[],
    targetCount: number
): SongID3[] {
    // Sort by score first
    const sorted = [...scoredSongs].sort((a, b) => b.score - a.score);

    const selected: SongID3[] = [];
    const artistCount = new Map<string, number>();
    const albumCount = new Map<string, number>();

    // Configurable diversity limits
    const MAX_SONGS_PER_ARTIST = 3; // Max songs from same artist
    const MAX_SONGS_PER_ALBUM = 2;  // Max songs from same album

    // First pass: select high-scoring songs with diversity constraints
    for (const item of sorted) {
        if (selected.length >= targetCount) break;

        const song = item.song;
        const artistIds = song.artists.map(a => a.id);
        const albumId = song.albumId || 'unknown';

        // Check if adding this song would violate diversity constraints
        const wouldExceedArtistLimit = artistIds.some(artistId =>
            (artistCount.get(artistId) || 0) >= MAX_SONGS_PER_ARTIST
        );
        const wouldExceedAlbumLimit = (albumCount.get(albumId) || 0) >= MAX_SONGS_PER_ALBUM;

        if (!wouldExceedArtistLimit && !wouldExceedAlbumLimit) {
            selected.push(song);

            // Update counts
            for (const artistId of artistIds) {
                artistCount.set(artistId, (artistCount.get(artistId) || 0) + 1);
            }
            albumCount.set(albumId, (albumCount.get(albumId) || 0) + 1);
        }
    }

    // Second pass: if we haven't hit target, relax constraints slightly
    if (selected.length < targetCount) {
        const RELAXED_MAX_ARTIST = 4;
        const RELAXED_MAX_ALBUM = 3;

        for (const item of sorted) {
            if (selected.length >= targetCount) break;

            const song = item.song;
            if (selected.some(s => s.id === song.id)) continue; // Already selected

            const artistIds = song.artists.map(a => a.id);
            const albumId = song.albumId || 'unknown';

            const wouldExceedRelaxedArtist = artistIds.some(artistId =>
                (artistCount.get(artistId) || 0) >= RELAXED_MAX_ARTIST
            );
            const wouldExceedRelaxedAlbum = (albumCount.get(albumId) || 0) >= RELAXED_MAX_ALBUM;

            if (!wouldExceedRelaxedArtist && !wouldExceedRelaxedAlbum) {
                selected.push(song);

                for (const artistId of artistIds) {
                    artistCount.set(artistId, (artistCount.get(artistId) || 0) + 1);
                }
                albumCount.set(albumId, (albumCount.get(albumId) || 0) + 1);
            }
        }
    }

    return selected;
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
        .map((item) => ({ item, rand: Math.random() }))
        .sort((a, b) => a.rand - b.rand)
        .map(({ item }) => item);
}

function calculateSimilarity(
    baseSong: SongID3,
    candidate: SongID3,
    seedType: 'song' | 'album' | 'artist' | null,
    seedItemId: string
): number {
    let score = 0;

    // Genre matching - most important for musical coherence
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
        score += 4; // Reduced from 6
        if (commonArtists.length === baseArtistIds.size && baseArtistIds.size > 0) {
            score += 2; // Reduced from 3
        }
        // Only boost if seed is specifically an artist
        if (seedType === 'artist' && candidateArtistIds.has(seedItemId)) {
            score += 6; // Reduced from 8
        }
    }

    // Album matching - minimal bonus
    if (baseSong.albumId && candidate.albumId === baseSong.albumId) {
        score += 2; // Reduced from 3
        if (seedType === 'album' && candidate.albumId === seedItemId) {
            score += 6; // Reduced from 8
        }
    }

    // BPM matching - good for energy/tempo similarity
    if (baseSong.bpm && candidate.bpm) {
        const bpmDiff = Math.abs(baseSong.bpm - candidate.bpm);
        if (bpmDiff <= 5) score += 12;
        else if (bpmDiff <= 10) score += 8;
        else if (bpmDiff <= 20) score += 4;
    }

    // Year proximity - helps maintain era consistency
    if (baseSong.year && candidate.year) {
        const yearDiff = Math.abs(baseSong.year - candidate.year);
        if (yearDiff <= 3) score += 8;
        else if (yearDiff <= 7) score += 5;
        else if (yearDiff <= 15) score += 2;
    }

    // User preference factors - high importance
    if (baseSong.starred && candidate.starred) score += 25;

    if (baseSong.userRating && candidate.userRating) {
        const ratingDiff = Math.abs(baseSong.userRating - candidate.userRating);
        if (ratingDiff === 0) score += 20;
        else if (ratingDiff <= 1) score += 15;
        else if (ratingDiff <= 2) score += 8;
    }

    // Play count similarity
    if (baseSong.playCount && candidate.playCount) {
        const playDiff = Math.abs(baseSong.playCount - candidate.playCount);
        const playSimilarity = Math.max(0, 20 - (playDiff / 5));
        score += playSimilarity;
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