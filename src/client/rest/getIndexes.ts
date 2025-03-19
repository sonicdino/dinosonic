import { Context, Hono } from 'hono';
import { createResponse, database, getField, validateAuth } from '../../util.ts';
import { Artist } from '../../zod.ts';

const getIndexes = new Hono();

async function handlegetIndexes(c: Context) {
    const isValidated = await validateAuth(c);
    if (isValidated instanceof Response) return isValidated;

    const id = parseInt(await getField(c, 'musicFolderId') || '0');
    if (!id) return createResponse(c, {}, 'failed', { code: 10, message: "Missing parameter: 'id'" });

    const artists = (await Array.fromAsync(database.list({ prefix: ['artists'] }))).map((artist) => (artist.value as Artist));

    // Group by first letter
    const indexes: Record<string, Artist[]> = {};
    for (const artist of artists) {
        const firstLetter = /^[A-Z]/i.test(artist.artist.name.charAt(0)) ? artist.artist.name.charAt(0).toUpperCase() : '#'; // Non-alphabetic names go under "#"

        if (!indexes[firstLetter]) indexes[firstLetter] = [];
        indexes[firstLetter].push(artist);
    }

    return createResponse(c, {
        indexes: {
            index: Object.entries(indexes)
                .map(([name, artists]) => ({
                    name,
                    artists: artists
                        .sort((a, b) => a.artist.name.localeCompare(b.artist.name, undefined, { sensitivity: 'base' }))
                        .map((artist) => ({
                            id: artist.artist.id,
                            name: artist.artist.name,
                            albumCount: artist.artist.albumCount,
                            coverArt: artist.artist.coverArt,
                            artistImageUrl:
                                (artist.artistInfo?.largeImageUrl || artist.artistInfo?.mediumImageUrl || artist.artistInfo?.smallImageUrl),
                        })),
                })),
        },
    }, 'ok');
}

getIndexes.get('/getIndexes', handlegetIndexes);
getIndexes.post('/getIndexes', handlegetIndexes);
getIndexes.get('/getIndexes.view', handlegetIndexes);
getIndexes.post('/getIndexes.view', handlegetIndexes);

export default getIndexes;
