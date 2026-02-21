import { database, generateId, logger } from '../util.ts';
import { ShareSchema } from '../zod.ts';

async function getSystemUserId(): Promise<string | null> {
    for await (const entry of database.list({ prefix: ['users'] })) {
        const user = entry.value as { backend?: { id: string }; subsonic?: { adminRole?: boolean } };
        if (user.subsonic?.adminRole && user.backend?.id) {
            return user.backend.id;
        }
    }
    return null;
}

export async function getOrCreateCoverArtShare(itemId: string, description?: string): Promise<string | null> {
    const existingShareKey = ['autoShares', 'coverArt', itemId];
    const existing = await database.get(existingShareKey);
    if (existing.value) {
        return existing.value as string;
    }

    const systemUserId = await getSystemUserId();
    if (!systemUserId) {
        logger.warn('No admin user found for auto-share creation');
        return null;
    }

    const shareId = await generateId();
    const now = new Date();

    const newShare = ShareSchema.parse({
        id: shareId,
        userId: systemUserId,
        itemId,
        itemType: 'coverArt',
        description: description || `Cover art`,
        created: now,
        expires: null,
        viewCount: 0,
    });

    await database.set(['shares', shareId], newShare);
    await database.set(existingShareKey, shareId);

    logger.info(`Created share ${shareId} for coverArt ${itemId}`);
    return shareId;
}

export async function getCoverArtShareUrl(itemId: string, size: number, baseUrl: string, description?: string): Promise<string | undefined> {
    const shareId = await getOrCreateCoverArtShare(itemId, description);
    if (!shareId) return undefined;
    return `${baseUrl}/share/${shareId}?size=${size}`;
}
