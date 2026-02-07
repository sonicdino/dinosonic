import { database } from './util.ts';
import { TranscodingProfile, TranscodingProfileSchema } from './zod.ts';

/**
 * Creates a new transcoding profile for a user
 * @param userId The ID of the user
 * @param profile The profile to create
 * @returns The created profile with validation
 */
export async function createTranscodingProfile(userId: string, profile: TranscodingProfile): Promise<TranscodingProfile | null> {
    const id = profile.id || await generateId();
    const newProfile: TranscodingProfile = {
        ...profile,
        id,
    };

    const validationResult = TranscodingProfileSchema.safeParse(newProfile);
    if (!validationResult.success) {
        console.error('Invalid transcoding profile:', validationResult.error);
        return null;
    }

    await database.set(['users', userId, 'transcodingProfiles', id], validationResult.data);
    return validationResult.data;
}

/**
 * Updates an existing transcoding profile for a user
 * @param userId The ID of the user
 * @param id The ID of the profile to update
 * @param profile The updated profile data
 * @returns The updated profile or null if not found/invalid
 */
export async function updateTranscodingProfile(userId: string, id: string, profile: TranscodingProfile): Promise<TranscodingProfile | null> {
    const existingProfile = await getTranscodingProfile(userId, id);
    if (!existingProfile) {
        return null;
    }

    const updatedProfile: TranscodingProfile = {
        ...existingProfile,
        ...profile,
    };

    const validationResult = TranscodingProfileSchema.safeParse(updatedProfile);
    if (!validationResult.success) {
        console.error('Invalid transcoding profile:', validationResult.error);
        return null;
    }

    await database.set(['users', userId, 'transcodingProfiles', id], validationResult.data);
    return validationResult.data;
}

/**
 * Gets a transcoding profile by ID for a user
 * @param userId The ID of the user
 * @param id The ID of the profile to retrieve
 * @returns The profile or null if not found
 */
export async function getTranscodingProfile(userId: string, id: string): Promise<TranscodingProfile | null> {
    const result = await database.get(['users', userId, 'transcodingProfiles', id]);
    if (!result.value) {
        return null;
    }

    const validationResult = TranscodingProfileSchema.safeParse(result.value);
    if (!validationResult.success) {
        console.error('Invalid transcoding profile in database:', validationResult.error);
        return null;
    }

    return validationResult.data;
}

/**
 * Gets all transcoding profiles for a user
 * @param userId The ID of the user
 * @returns Array of all transcoding profiles for the user
 */
export async function getAllTranscodingProfiles(userId: string): Promise<TranscodingProfile[]> {
    const profiles: TranscodingProfile[] = [];
    for await (const entry of database.list({ prefix: ['users', userId, 'transcodingProfiles'] })) {
        const validationResult = TranscodingProfileSchema.safeParse(entry.value);
        if (validationResult.success) {
            profiles.push(validationResult.data);
        } else {
            console.error('Invalid transcoding profile in database:', validationResult.error);
        }
    }
    return profiles;
}

/**
 * Deletes a transcoding profile by ID for a user
 * @param userId The ID of the user
 * @param id The ID of the profile to delete
 */
export async function deleteTranscodingProfile(userId: string, id: string): Promise<void> {
    await database.delete(['users', userId, 'transcodingProfiles', id]);
}

/**
 * Finds the most appropriate transcoding profile for a given client and user
 * @param userId The ID of the user
 * @param clientInfo Information about the requesting client (client name, etc.)
 * @returns The most appropriate profile or null if no match
 */
export async function getMatchingProfile(
    userId: string,
    // deno-lint-ignore no-explicit-any
    clientInfo: { clientName?: string; [key: string]: any },
): Promise<TranscodingProfile | null> {
    const allProfiles = await getAllTranscodingProfiles(userId);

    // Filter to enabled profiles only
    const enabledProfiles = allProfiles.filter((profile) => profile.enabled);

    // Try to match by client name first
    if (clientInfo.clientName) {
        for (const profile of enabledProfiles) {
            if (profile.clientMatch) {
                try {
                    const regex = new RegExp(profile.clientMatch, 'i');
                    if (regex.test(clientInfo.clientName)) {
                        return profile;
                    }
                } catch (e) {
                    console.error(`Invalid regex in transcoding profile ${profile.id}:`, e);
                }
            }
        }
    }

    // If no client-specific match, return the default/first enabled profile
    return enabledProfiles.length > 0 ? enabledProfiles[0] : null;
}

/**
 * Generates a unique ID for transcoding profiles
 * @returns A unique ID string
 */
function generateId(): string {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
