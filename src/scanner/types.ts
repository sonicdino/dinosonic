// Scanner type definitions
export interface ScanStatus {
    scanning: boolean;
    count: number;
    totalFiles: number;
    lastScan: Date;
    errors: string[];
}

export interface ScanOptions {
    cleanup?: boolean;
    debugLog?: boolean;
    skipExternalMetadata?: boolean;
    skipLastFMSync?: boolean;
}

export interface CoverArtSource {
    data: Uint8Array;
    format: string;
    source: string;
}

export interface MetadataExtractionResult {
    success: boolean;
    // deno-lint-ignore no-explicit-any
    data?: any;
    error?: string;
}

export interface ExternalMetadataConfig {
    lastFm?: {
        enabled: boolean;
        apiKey?: string;
        apiSecret?: string;
    };
    spotify?: {
        enabled: boolean;
        clientId?: string;
        clientSecret?: string;
    };
    musicBrainz?: {
        enabled: boolean;
        userAgent?: string;
    };
}

export interface RetryOptions {
    maxAttempts: number;
    initialDelayMs: number;
    backoffMultiplier: number;
    maxDelayMs: number;
}

export interface MusicBrainzRecording {
    id: string;
    title: string;
    length?: number;
    'artist-credit'?: Array<{
        name: string;
        artist: {
            id: string;
            name: string;
        };
    }>;
    releases?: Array<{
        id: string;
        title: string;
        date?: string;
    }>;
    tags?: Array<{
        count: number;
        name: string;
    }>;
    genres?: Array<{
        count: number;
        name: string;
    }>;
}

export interface MusicBrainzRelease {
    id: string;
    title: string;
    date?: string;
    'cover-art-archive'?: {
        artwork: boolean;
        front: boolean;
        back: boolean;
    };
    'artist-credit'?: Array<{
        name: string;
        artist: {
            id: string;
            name: string;
        };
    }>;
    media?: Array<{
        position: number;
        title?: string;
        'track-count': number;
        tracks?: Array<{
            id: string;
            position: number;
            title: string;
            length?: number;
        }>;
    }>;
    tags?: Array<{
        count: number;
        name: string;
    }>;
    genres?: Array<{
        count: number;
        name: string;
    }>;
    'release-group'?: {
        id: string;
        'primary-type'?: string;
        'secondary-types'?: string[];
    };
    'label-info'?: Array<{
        label?: {
            id: string;
            name: string;
        };
        'catalog-number'?: string;
    }>;
    country?: string;
    status?: string;
    barcode?: string;
}

export interface MusicBrainzArtist {
    id: string;
    name: string;
    type?: string;
    disambiguation?: string;
    'life-span'?: {
        begin?: string;
        end?: string;
    };
    area?: {
        name: string;
    };
    'begin-area'?: {
        name: string;
    };
    country?: string;
    tags?: Array<{
        count: number;
        name: string;
    }>;
    genres?: Array<{
        count: number;
        name: string;
    }>;
}

export interface ExternalMetadata {
    musicBrainz?: {
        recordingId?: string;
        releaseId?: string;
        artistIds?: string[];
        coverArtAvailable?: boolean;
        genres?: string[];
        tags?: string[];
        releaseType?: string;
        releaseDate?: string;
        label?: string;
        country?: string;
    };
    lastFm?: {
        // deno-lint-ignore no-explicit-any
        artistInfo?: any;
        // deno-lint-ignore no-explicit-any
        albumInfo?: any;
    };
    spotify?: {
        artistImages?: Array<{ size: string; url: string }>;
    };
}

export interface MetadataCache {
    key: string;
    // deno-lint-ignore no-explicit-any
    data: any;
    fetchedAt: number;
}
