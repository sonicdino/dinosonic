import { Context, Hono } from '@hono/hono';
import { createResponse, database, getUserByUsername, logger, validateAuth } from '../../util.ts';
import { Album, AlbumSchema, Playlist, PlaylistSchema, Share, Song, SongSchema, User } from '../../zod.ts';

const getShares = new Hono();

async function handleGetShares(c: Context) {
    const userAuth = await validateAuth(c);
    if (userAuth instanceof Response) return userAuth;

    const user = await getUserByUsername(userAuth.username);
    if (!user) return createResponse(c, {}, 'failed', { code: 0, message: 'Authenticated user not found.' });

    const sharesResponseList: unknown[] = [];

    for await (const dbEntry of database.list({ prefix: ['shares'] })) {
        const share = dbEntry.value as Share;

        if (share.itemType === 'coverArt') {
            // logger.debug(`Skipping coverArt share ${share.id} from getShares listing.`);
            continue;
        }

        if (userAuth.adminRole || share.userId === user.backend.id) {
            const shareOwnerEntry = await database.get(['users', share.userId]);
            const shareOwner = shareOwnerEntry.value ? (shareOwnerEntry.value as User).subsonic.username : 'Unknown';
            const shareUrl = `${new URL(c.req.url).origin}/share/${share.id}`;

            const responseEntries = [];
            let itemTitle = share.description || share.itemType; // Fallback title

            try {
                if (share.itemType === 'song') {
                    const songEntry = await database.get(['tracks', share.itemId]);
                    if (songEntry.value) {
                        const song = SongSchema.parse(songEntry.value);
                        responseEntries.push(song.subsonic);
                        itemTitle = song.subsonic.title;
                    }
                } else if (share.itemType === 'album') {
                    const albumEntry = await database.get(['albums', share.itemId]);
                    if (albumEntry.value) {
                        const album = AlbumSchema.parse(albumEntry.value) as Album;
                        itemTitle = album.subsonic.name;
                        for (const songId of album.subsonic.song) {
                            const songVal = (await database.get(['tracks', songId as string])).value;
                            if (songVal) responseEntries.push((SongSchema.parse(songVal) as Song).subsonic);
                        }
                    }
                } else if (share.itemType === 'playlist') {
                    const playlistEntry = await database.get(['playlists', share.itemId]);
                    if (playlistEntry.value) {
                        const playlist = PlaylistSchema.parse(playlistEntry.value) as Playlist;
                        itemTitle = playlist.name;
                        for (const songId of playlist.entry) {
                            const songVal = (await database.get(['tracks', songId as string])).value;
                            if (songVal) responseEntries.push((SongSchema.parse(songVal) as Song).subsonic);
                        }
                    }
                }
                // deno-lint-ignore no-explicit-any
            } catch (e: any) {
                logger.error(`Error fetching details for shared item ${share.itemId} (share ${share.id}): ${e.message}`);
            }

            sharesResponseList.push({
                id: share.id,
                url: shareUrl,
                description: share.description || itemTitle,
                username: shareOwner,
                created: share.created.toISOString(),
                expires: share.expires?.toISOString(),
                lastVisited: share.lastViewed?.toISOString(),
                visitCount: share.viewCount,
                entry: responseEntries.length > 0 ? responseEntries : [{ id: share.itemId, title: itemTitle, isDir: false }], // Fallback
            });
        }
    }

    sharesResponseList.sort((a, b) =>
        new Date((b as { created: string }).created).getTime() - new Date((a as { created: string }).created).getTime()
    );

    return createResponse(c, { shares: { share: sharesResponseList } });
}

getShares.get('/getShares', handleGetShares);
getShares.post('/getShares', handleGetShares);
getShares.get('/getShares.view', handleGetShares);
getShares.post('/getShares.view', handleGetShares);

export default getShares;
