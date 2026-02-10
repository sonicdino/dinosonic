import { Context, Hono } from '@hono/hono';
import { createResponse, database, getField, getUserByUsername, logger, validateAuth } from '../../util.ts';
import { getSimilarTracks } from '../../LastFM.ts';
import { AlbumSchema, ArtistSchema, SongID3, SongSchema, userData } from '../../zod.ts';

const getSimilarSongs = new Hono();

async function handlegetSimilarSongs(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const count = parseInt(await getField(c, 'count') || '50');
    const inputId = await getField(c, 'id') || '';

    if (!inputId) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const user = await getUserByUsername(isValidated.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: "Logged in user doesn't exist?" });

    const seedResult = await gatherSeedSongs(inputId, user.backend.id);
    if (!seedResult.seeds.length) {
        return createResponse(c, {}, 'failed', { code: 70, message: 'Invalid ID or no songs found for similarity matching' });
    }

    logger.debug(`Similarity search: ${seedResult.seeds.length} seeds, type=${seedResult.type}, id=${seedResult.itemId}`);

    const candidates = await gatherCandidateSongs(seedResult.itemId, seedResult.type, user.backend.id);
    const lastFmBoosts = await fetchLastFmBoosts(seedResult.seeds, candidates);

    const scoredSongs = candidates
        .filter((song) => !seedResult.seeds.some((s) => s.id === song.id))
        .map((song) => {
            const maxScore = Math.max(...seedResult.seeds.map((seed) => calculateSimilarity(seed, song, seedResult.type, seedResult.itemId)));
            const lastFmBoost = lastFmBoosts.get(song.id) || 0;
            return { song, score: maxScore + lastFmBoost };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

    const relatedSongs = await getRelatedButNotSeedSongs(seedResult.itemId, seedResult.type, seedResult.seeds, user.backend.id);

    // Merge: relatedSongs take priority (higher score for same-seed-item songs),
    // then append scoredSongs that aren't already present to avoid duplicates.
    const seenIds = new Set(relatedSongs.map((r) => r.song.id));
    const combined = [
        ...relatedSongs,
        ...scoredSongs.filter((s) => !seenIds.has(s.song.id)),
    ];
    const diverse = selectDiverseSongs(combined, count);

    return createResponse(c, {
        [/(getSimilarSongs2|getSimilarSongs2\.view)$/.test(c.req.path) ? 'similarSongs2' : 'similarSongs']: {
            song: diverse,
        },
    }, 'ok');
}

async function gatherSeedSongs(inputId: string, userId: string) {
    const seeds: SongID3[] = [];
    let type: 'song' | 'album' | 'artist' | null = null;
    let itemId = inputId;

    const songEntry = await database.get(['tracks', inputId]);
    if (songEntry.value) {
        const parsed = SongSchema.safeParse(songEntry.value);
        if (parsed.success) {
            seeds.push(await enrichSong(parsed.data.subsonic, userId));
            type = 'song';
            return { seeds, type, itemId };
        }
    }

    const albumEntry = await database.get(['albums', inputId]);
    if (albumEntry.value) {
        const parsed = AlbumSchema.safeParse(albumEntry.value);
        if (parsed.success) {
            type = 'album';
            itemId = parsed.data.subsonic.id;
            const songIds = parsed.data.subsonic.song
                .slice(0, 5)
                .map((s) => typeof s === 'string' ? s : (s as SongID3).id);

            for (const id of songIds) {
                const track = await database.get(['tracks', id]);
                if (track.value) {
                    const songData = SongSchema.safeParse(track.value);
                    if (songData.success) seeds.push(await enrichSong(songData.data.subsonic, userId));
                }
            }
            return { seeds, type, itemId };
        }
    }

    const artistEntry = await database.get(['artists', inputId]);
    if (artistEntry.value) {
        const parsed = ArtistSchema.safeParse(artistEntry.value);
        if (parsed.success) {
            type = 'artist';
            itemId = parsed.data.artist.id;
            const artistId = parsed.data.artist.id;

            for await (const entry of database.list({ prefix: ['tracks'] })) {
                const songData = SongSchema.safeParse(entry.value);
                if (songData.success && songData.data.subsonic.artists.some((a) => a.id === artistId)) {
                    seeds.push(await enrichSong(songData.data.subsonic, userId));
                    if (seeds.length >= 5) break;
                }
            }
            return { seeds, type, itemId };
        }
    }

    return { seeds, type, itemId };
}

async function gatherCandidateSongs(seedItemId: string, seedType: 'song' | 'album' | 'artist' | null, userId: string): Promise<SongID3[]> {
    const candidates: SongID3[] = [];

    for await (const entry of database.list({ prefix: ['tracks'] })) {
        const parsed = SongSchema.safeParse(entry.value);
        if (!parsed.success) continue;

        const song = parsed.data.subsonic;
        const isSameAlbum = seedType === 'album' && song.albumId === seedItemId;
        const isSameArtist = seedType === 'artist' && song.artists.some((a) => a.id === seedItemId);

        if (!isSameAlbum && !isSameArtist) {
            candidates.push(await enrichSong(song, userId));
        }
    }

    return candidates;
}

async function fetchLastFmBoosts(seeds: SongID3[], candidates: SongID3[]): Promise<Map<string, number>> {
    const boosts = new Map<string, number>();
    const candidateMap = new Map(candidates.map((c) => [
        `${c.artist.toLowerCase()}|${c.title.toLowerCase()}`,
        c.id,
    ]));

    for (const seed of seeds) {
        try {
            const similar = await getSimilarTracks(seed.artist, seed.title, 50);
            for (const track of similar) {
                const key = `${track.artist.toLowerCase()}|${track.name.toLowerCase()}`;
                const songId = candidateMap.get(key);
                if (songId) {
                    const boost = track.match * 10;
                    boosts.set(songId, Math.max(boosts.get(songId) || 0, boost));
                }
            }
        } catch (error) {
            logger.debug(`Last.fm error for ${seed.artist} - ${seed.title}: ${error}`);
        }
    }

    return boosts;
}

async function getRelatedButNotSeedSongs(
    seedItemId: string,
    seedType: 'song' | 'album' | 'artist' | null,
    seeds: SongID3[],
    userId: string,
): Promise<Array<{ song: SongID3; score: number }>> {
    const related: Array<{ song: SongID3; score: number }> = [];

    if (seedType === 'album') {
        const albumEntry = await database.get(['albums', seedItemId]);
        if (albumEntry.value) {
            const album = AlbumSchema.parse(albumEntry.value).subsonic;
            const unseeded = album.song
                .map((s) => typeof s === 'string' ? s : (s as SongID3).id)
                .filter((id) => !seeds.some((seed) => seed.id === id))
                .slice(0, 3);

            for (const songId of unseeded) {
                const track = await database.get(['tracks', songId]);
                if (track.value) {
                    const songData = SongSchema.parse(track.value);
                    related.push({ song: await enrichSong(songData.subsonic, userId), score: 60 });
                }
            }
        }
    } else if (seedType === 'artist') {
        let found = 0;
        for await (const entry of database.list({ prefix: ['tracks'] })) {
            if (found >= 3) break;
            const songData = SongSchema.safeParse(entry.value);
            if (songData.success) {
                const song = songData.data;
                if (song.subsonic.artists.some((a) => a.id === seedItemId) && !seeds.some((s) => s.id === song.subsonic.id)) {
                    related.push({ song: await enrichSong(song.subsonic, userId), score: 50 });
                    found++;
                }
            }
        }
    }

    return related;
}

function selectDiverseSongs(
    scored: Array<{ song: SongID3; score: number }>,
    targetCount: number,
): SongID3[] {
    if (scored.length === 0) return [];

    // Deduplicate the input pool by song id — callers may merge sources that overlap
    const seen = new Set<string>();
    const pool = scored.filter((item) => {
        if (seen.has(item.song.id)) return false;
        seen.add(item.song.id);
        return true;
    });

    if (pool.length <= targetCount) return pool.map((s) => s.song);

    // Allow up to MAX_CONSECUTIVE songs from the same artist/album in a row,
    // then enforce a minimum spacing gap before that artist/album can appear again.
    const MAX_CONSECUTIVE_ARTIST = 2;
    const MAX_CONSECUTIVE_ALBUM = 2;
    const MIN_ARTIST_DISTANCE = 4;
    const MIN_ALBUM_DISTANCE = 6;

    const selected: SongID3[] = [];
    const artistRunCount = new Map<string, number>(); // consecutive run length per artist
    const albumRunCount = new Map<string, number>(); // consecutive run length per album
    const artistLastIndex = new Map<string, number>();
    const albumLastIndex = new Map<string, number>();

    const canPlace = (song: SongID3, relaxed: boolean): boolean => {
        const artistIds = song.artists.map((a) => a.id);
        const albumId = song.albumId || 'unknown';
        const pos = selected.length;

        const artistDist = MIN_ARTIST_DISTANCE;
        const albumDist = MIN_ALBUM_DISTANCE;

        for (const artistId of artistIds) {
            const lastIdx = artistLastIndex.get(artistId);
            if (lastIdx === undefined) continue;
            const distance = pos - lastIdx;
            // Within the gap: only allow if we haven't hit the consecutive cap yet
            if (distance < (relaxed ? Math.ceil(artistDist / 2) : artistDist)) {
                const run = artistRunCount.get(artistId) || 0;
                if (run >= MAX_CONSECUTIVE_ARTIST) return false;
            }
        }

        const lastAlbumIdx = albumLastIndex.get(albumId);
        if (lastAlbumIdx !== undefined) {
            const distance = pos - lastAlbumIdx;
            if (distance < (relaxed ? Math.ceil(albumDist / 2) : albumDist)) {
                const run = albumRunCount.get(albumId) || 0;
                if (run >= MAX_CONSECUTIVE_ALBUM) return false;
            }
        }

        return true;
    };

    const commit = (song: SongID3) => {
        const artistIds = song.artists.map((a) => a.id);
        const albumId = song.albumId || 'unknown';
        const pos = selected.length;

        // Update consecutive run counts: reset for artists/albums not in this song
        // and increment for those that are
        for (const [id, lastIdx] of artistLastIndex.entries()) {
            if (pos - lastIdx === 1 && artistIds.includes(id)) {
                artistRunCount.set(id, (artistRunCount.get(id) || 0) + 1);
            } else if (pos - lastIdx > 0) {
                artistRunCount.set(id, 0);
            }
        }
        for (const artistId of artistIds) {
            if (!artistLastIndex.has(artistId)) artistRunCount.set(artistId, 1);
            artistLastIndex.set(artistId, pos);
        }

        const lastAlbumIdx = albumLastIndex.get(albumId);
        if (lastAlbumIdx !== undefined && pos - lastAlbumIdx === 1) {
            albumRunCount.set(albumId, (albumRunCount.get(albumId) || 0) + 1);
        } else {
            albumRunCount.set(albumId, 1);
        }
        albumLastIndex.set(albumId, pos);

        selected.push(song);
    };

    // Pass 1: strict spacing with consecutive grouping allowed
    for (const item of pool) {
        if (selected.length >= targetCount) break;
        if (canPlace(item.song, false)) commit(item.song);
    }

    // Pass 2: relaxed spacing for the remainder
    if (selected.length < targetCount) {
        const selectedIds = new Set(selected.map((s) => s.id));
        for (const item of pool) {
            if (selected.length >= targetCount) break;
            if (selectedIds.has(item.song.id)) continue;
            if (canPlace(item.song, true)) {
                commit(item.song);
                selectedIds.add(item.song.id);
            }
        }
    }

    // Pass 3: fill any remaining slots with whatever is left, no distance checks
    if (selected.length < targetCount) {
        const selectedIds = new Set(selected.map((s) => s.id));
        for (const item of pool) {
            if (selected.length >= targetCount) break;
            if (!selectedIds.has(item.song.id)) {
                selected.push(item.song);
                selectedIds.add(item.song.id);
            }
        }
    }

    return selected;
}

async function enrichSong(song: SongID3, userId: string): Promise<SongID3> {
    const userData = ((await database.get(['userData', userId, 'track', song.id])).value as userData) || {};
    return {
        ...song,
        starred: userData.starred ? userData.starred.toISOString() : undefined,
        playCount: userData.playCount,
        userRating: userData.userRating,
    };
}

function calculateSimilarity(
    base: SongID3,
    candidate: SongID3,
    seedType: 'song' | 'album' | 'artist' | null,
    seedItemId: string,
): number {
    let score = 0;

    if (base.genre && candidate.genre && base.genre.toLowerCase() === candidate.genre.toLowerCase()) {
        score += 20;
    } else if (base.genres && candidate.genres) {
        const match = base.genres.some((g1) => candidate.genres!.some((g2) => g1.name.toLowerCase() === g2.name.toLowerCase()));
        if (match) score += 15;
    }

    const baseArtists = new Set(base.artists.map((a) => a.id));
    const candidateArtists = new Set(candidate.artists.map((a) => a.id));
    const commonArtists = [...baseArtists].filter((id) => candidateArtists.has(id));

    if (commonArtists.length > 0) {
        score += 4;
        if (commonArtists.length === baseArtists.size) score += 2;
        if (seedType === 'artist' && candidateArtists.has(seedItemId)) score += 6;
    }

    if (base.albumId && candidate.albumId === base.albumId) {
        score += 2;
        if (seedType === 'album' && candidate.albumId === seedItemId) score += 6;
    }

    if (base.bpm && candidate.bpm) {
        const diff = Math.abs(base.bpm - candidate.bpm);
        if (diff <= 5) score += 12;
        else if (diff <= 10) score += 8;
        else if (diff <= 20) score += 4;
    }

    if (base.year && candidate.year) {
        const diff = Math.abs(base.year - candidate.year);
        if (diff <= 3) score += 8;
        else if (diff <= 7) score += 5;
        else if (diff <= 15) score += 2;
    }

    if (base.starred && candidate.starred) score += 25;

    if (base.userRating && candidate.userRating) {
        const diff = Math.abs(base.userRating - candidate.userRating);
        if (diff === 0) score += 20;
        else if (diff <= 1) score += 15;
        else if (diff <= 2) score += 8;
    }

    if (base.playCount && candidate.playCount) {
        const diff = Math.abs(base.playCount - candidate.playCount);
        score += Math.max(0, 20 - (diff / 5));
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
