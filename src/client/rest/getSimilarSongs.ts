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

    const candidates = await gatherCandidateSongs(user.backend.id);
    const lastFmBoosts = await fetchLastFmBoosts(seedResult.seeds, candidates);

    const seedIds = new Set(seedResult.seeds.map((s) => s.id));
    const scored = candidates
        .filter((song) => !seedIds.has(song.id))
        .map((song) => {
            const maxScore = Math.max(...seedResult.seeds.map((seed) => calculateSimilarity(seed, song, seedResult.type, seedResult.itemId)));
            const lastFmBoost = lastFmBoosts.get(song.id) || 0;
            return { song, score: maxScore + lastFmBoost };
        });

    const diverse = buildMix(scored, count);

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

async function gatherCandidateSongs(userId: string): Promise<SongID3[]> {
    const candidates: SongID3[] = [];

    for await (const entry of database.list({ prefix: ['tracks'] })) {
        const parsed = SongSchema.safeParse(entry.value);
        if (!parsed.success) continue;
        candidates.push(await enrichSong(parsed.data.subsonic, userId));
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

function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function buildMix(
    scored: Array<{ song: SongID3; score: number }>,
    targetCount: number,
): SongID3[] {
    if (scored.length === 0) return [];

    // Deduplicate by song id
    const seen = new Set<string>();
    const pool = scored.filter((item) => {
        if (seen.has(item.song.id)) return false;
        seen.add(item.song.id);
        return true;
    });

    if (pool.length === 0) return [];

    // Split into score tiers, shuffle within each tier for per-session variety.
    // Tiers: high (top third of score range), mid, low, unscored (score=0).
    const maxScore = Math.max(...pool.map((i) => i.score));
    const tierHigh: Array<{ song: SongID3; score: number }> = [];
    const tierMid: Array<{ song: SongID3; score: number }> = [];
    const tierLow: Array<{ song: SongID3; score: number }> = [];
    const tierZero: Array<{ song: SongID3; score: number }> = [];

    for (const item of pool) {
        if (item.score === 0) {
            tierZero.push(item);
        } else if (maxScore > 0 && item.score >= maxScore * 0.6) {
            tierHigh.push(item);
        } else if (maxScore > 0 && item.score >= maxScore * 0.25) {
            tierMid.push(item);
        } else {
            tierLow.push(item);
        }
    }

    shuffle(tierHigh);
    shuffle(tierMid);
    shuffle(tierLow);
    shuffle(tierZero);

    // Group each tier into per-artist buckets, then interleave across artists
    // using a round-robin so no artist dominates a run.
    const interleave = (tier: Array<{ song: SongID3; score: number }>): SongID3[] => {
        const buckets = new Map<string, SongID3[]>();
        for (const item of tier) {
            const key = item.song.artists[0]?.id || 'unknown';
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key)!.push(item.song);
        }
        const queues = [...buckets.values()];
        const out: SongID3[] = [];
        let i = 0;
        while (out.length < tier.length) {
            let added = false;
            for (let q = 0; q < queues.length; q++) {
                const queue = queues[(q + i) % queues.length];
                if (queue.length > 0) {
                    out.push(queue.shift()!);
                    added = true;
                }
            }
            if (!added) break;
            i++;
        }
        return out;
    };

    // Build final list: high-tier songs first (most similar), then mid, low, zero
    // so the mix starts with the most relevant songs and gradually broadens.
    const ordered = [
        ...interleave(tierHigh),
        ...interleave(tierMid),
        ...interleave(tierLow),
        ...interleave(tierZero),
    ];

    // Final pass: enforce no same-artist back-to-back by bumping offenders forward
    // without dropping any songs. Walk the list; if a song violates the gap, pull
    // the next eligible song forward to swap it in.
    const MIN_ARTIST_GAP = 3;
    const result: SongID3[] = [];
    const pending = [...ordered];

    while (result.length < targetCount && pending.length > 0) {
        const pos = result.length;
        let placed = false;

        for (let i = 0; i < pending.length; i++) {
            const song = pending[i];
            const artistIds = song.artists.map((a) => a.id);

            const tooClose = artistIds.some((id) => {
                for (let back = 1; back <= MIN_ARTIST_GAP && back <= pos; back++) {
                    if (result[pos - back].artists.some((a) => a.id === id)) return true;
                }
                return false;
            });

            if (!tooClose) {
                result.push(song);
                pending.splice(i, 1);
                placed = true;
                break;
            }
        }

        // Every remaining song violates the gap — just take the next one
        if (!placed) {
            result.push(pending.shift()!);
        }
    }

    return result;
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
