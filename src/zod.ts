import { z } from 'zod';

export const userDataSchema = z.object({
    id: z.string(),
    starred: z.date().optional(),
    played: z.date().optional(),
    playCount: z.number().optional(),
    userRating: z.number().optional(),
});

export const CoverArtSchema = z.object({
    id: z.string(),
    mimeType: z.string(),
    path: z.string(),
});

export const ConfigTranscodingOptionSchema = z.object({
    enabled: z.boolean().default(false),
    ffmpeg_path: z.string().default('ffmpeg'),
});

export const ConfigLastFMOptionSchema = z.object({
    enabled: z.boolean().default(false),
    enable_scrobbling: z.boolean().default(false),
    api_key: z.string().optional(),
    api_secret: z.string().optional(),
}).refine((data) => !data.enabled || (data.enabled && data.api_key), {
    message: 'API Key is required when LastFM is enabled',
    path: ['api_key'],
}).refine((data) => !data.enable_scrobbling || (data.enable_scrobbling && data.api_key && data.api_secret), {
    message: 'API key and API secret are required when scrobbling is enabled',
    path: ['api_key', 'api_secret'],
});

export const ConfigSpotifyOptionSchema = z.object({
    enabled: z.boolean().default(false),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
}).refine((data) => !data.enabled || (data.enabled && data.client_id), {
    message: 'client_id is required when spotify is enabled',
    path: ['client_id'],
}).refine((data) => !data.enabled || (data.enabled && data.client_secret), {
    message: 'client_secret is required when spotify is enabled',
    path: ['client_secret'],
});

export const ConfigSchema = z.object({
    port: z.number(),
    log_level: z.string().default('OFF'),
    data_folder: z.string(),
    transcoding: ConfigTranscodingOptionSchema.optional(),
    last_fm: ConfigLastFMOptionSchema.optional(),
    spotify: ConfigSpotifyOptionSchema.optional(),
    music_folders: z.array(z.string()).default([]),
    scan_on_start: z.boolean().default(false),
    scan_interval: z.string().default('1d'),
    artist_separators: z.array(z.string()).default([';', '/']),
    genre_separators: z.array(z.string()).default([';', ',']),
    default_admin_password: z.string().default('adminPassword'),
});

export const ReplayGainSchema = z.object({
    trackGain: z.number().optional(),
    trackPeak: z.number().optional(),
    albumGain: z.number().optional(),
    albumPeak: z.number().optional(),
    baseGain: z.number().optional(),
    fallbackGain: z.number().optional(),
});

export const ContributorSchema = z.object({
    id: z.string(),
    name: z.string(),
    role: z.string().optional(),
});

export const GenreSchema = z.object({
    name: z.string(),
});

export const RecordLabelSchema = z.object({
    name: z.string(),
});

export const AlbumReleaseDateSchema = z.object({
    year: z.number(),
    month: z.number(),
    day: z.number(),
});

export const DiscTitlesSchema = z.object({
    disc: z.number(),
    title: z.string(),
});

export const AlbumID3ArtistsSchema = z.object({
    id: z.string(),
    name: z.string(),
});

export const StructuredLyricsSchema = z.object({
    displayArtist: z.string(),
    displayTitle: z.string(),
    lang: z.string().default('xxx'),
    offset: z.number().optional(),
    synced: z.boolean().default(false),
    line: z.array(z.object({ start: z.number().optional(), value: z.string() })),
});

export const SongID3Schema = z.object({
    id: z.string(),
    parent: z.string().optional(),
    isDir: z.boolean().default(false),
    title: z.string(),
    album: z.string(),
    artist: z.string(),
    track: z.number().optional(),
    year: z.number().optional(),
    genre: z.string().optional(),
    coverArt: z.string().optional(),
    size: z.number().optional(),
    contentType: z.string().optional(),
    suffix: z.string().optional(),
    transcodedContentType: z.string().optional(),
    transcodedSuffix: z.string().optional(),
    duration: z.number(),
    bitRate: z.number().optional(),
    bitDepth: z.number().optional(),
    samplingRate: z.number().optional(),
    channelCount: z.number().optional(),
    path: z.string(),
    isVideo: z.boolean().optional(),
    userRating: z.number().min(1).max(5).optional(),
    averageRating: z.number().min(1.0).max(5.0).optional(),
    playCount: z.number().optional(),
    discNumber: z.number().default(0),
    created: z.string().optional(),
    starred: z.string().optional(),
    albumId: z.string(),
    artistId: z.string().optional(),
    type: z.string().optional(),
    mediaType: z.string().optional(),
    bookmarkPosition: z.number().optional(),
    originalWidth: z.number().optional(),
    originalHeight: z.number().optional(),
    played: z.string().optional(),
    bpm: z.number().optional(),
    comment: z.string().optional(),
    sortName: z.string().optional(),
    musicBrainzId: z.string().optional(),
    genres: z.array(GenreSchema).optional(),
    artists: z.array(AlbumID3ArtistsSchema).default([]),
    displayArtist: z.string().optional(),
    albumArtists: z.array(AlbumID3ArtistsSchema).default([]),
    displayAlbumArtist: z.string().optional(),
    contributors: z.array(ContributorSchema).optional(),
    displayComposer: z.string().optional(),
    moods: z.array(z.string()).optional(),
    replayGain: ReplayGainSchema.optional(),
    explicitStatus: z.enum(['explicit', 'clean', '']).optional(),
});

export const SongSchema = z.object({
    backend: z.object({
        lastModified: z.number(),
        lastFM: z.boolean().default(false),
        lyrics: z.array(StructuredLyricsSchema).default([]),
    }),
    subsonic: SongID3Schema,
});

export const AlbumID3Schema = z.object({
    id: z.string(),
    name: z.string(),
    artist: z.string(),
    year: z.number().optional(),
    coverArt: z.string().optional(),
    starred: z.string().optional(),
    duration: z.number(),
    playCount: z.number().optional(),
    genre: z.string().optional(),
    created: z.string(),
    artistId: z.string().optional(),
    songCount: z.number(),
    played: z.string().optional(),
    userRating: z.number().optional(),
    recordLabels: z.array(RecordLabelSchema).optional(),
    musicBrainzId: z.string().optional(),
    genres: z.array(GenreSchema).optional(),
    artists: z.array(AlbumID3ArtistsSchema).default([]),
    displayArtist: z.string().optional(),
    releaseTypes: z.array(z.string()).optional(),
    moods: z.array(z.string()).optional(),
    sortName: z.string().optional(),
    originalReleaseDate: AlbumReleaseDateSchema.optional(),
    releaseDate: AlbumReleaseDateSchema.optional(),
    isCompilation: z.boolean().optional(),
    explicitStatus: z.string().optional(),
    discTitles: z.array(DiscTitlesSchema).default([]),
    song: z.array(z.string().or(SongSchema).or(SongID3Schema)).default([]),
});

export const AlbumInfoSchema = z.object({
    notes: z.string().optional(),
    musicBrainzId: z.string().optional(),
    lastFmUrl: z.string().optional(),
    smallImageUrl: z.string().optional(),
    mediumImageUrl: z.string().optional(),
    largeImageUrl: z.string().optional(),
});

export const AlbumSchema = z.object({
    backend: z.object({
        dateAdded: z.number(),
        lastFM: z.boolean().default(false),
    }),
    albumInfo: AlbumInfoSchema.optional(),
    subsonic: AlbumID3Schema,
});

export const ArtistID3Schema = z.object({
    id: z.string(),
    name: z.string(),
    coverArt: z.string().optional(),
    artistImageUrl: z.string().optional(),
    albumCount: z.number().default(0),
    starred: z.string().optional(),
    userRating: z.number().optional(),
    musicBrainzId: z.string().optional(),
    sortName: z.string().optional(),
    roles: z.array(z.string()).optional(),
    album: z.array(z.string().or(AlbumID3Schema)).default([]),
});

export const ArtistInfoSchema = z.object({
    id: z.string(),
    biography: z.string().optional(),
    musicBrainzId: z.string().optional(),
    lastFmUrl: z.string().optional(),
    smallImageUrl: z.string().optional(),
    mediumImageUrl: z.string().optional(),
    largeImageUrl: z.string().optional(),
    similarArtist: z.array(z.string()).default([]),
});

export const ArtistSchema = z.object({
    lastFM: z.boolean().default(false),
    artistInfo: ArtistInfoSchema.optional(),
    artist: ArtistID3Schema,
});

export const SubsonicUserSchema = z.object({
    username: z.string(),
    email: z.string().optional(),
    scrobblingEnabled: z.boolean(),
    maxBitRate: z.number().optional(),
    adminRole: z.boolean(),
    settingsRole: z.boolean(),
    downloadRole: z.boolean(),
    uploadRole: z.boolean().default(false),
    playlistRole: z.boolean(),
    coverArtRole: z.boolean().default(false),
    commentRole: z.boolean().default(false),
    podcastRole: z.boolean().default(false),
    streamRole: z.boolean().default(true),
    jukeboxRole: z.boolean().default(false),
    shareRole: z.boolean().default(false),
    avatarLastChanged: z.date().optional(),
    folder: z.array(z.string()).optional(),
});

export const PlayQueueSchema = z.object({
    current: z.string(),
    position: z.number(),
    username: z.string(),
    changed: z.date(),
    changedBy: z.string(),
    entry: z.array(z.string().or(SongID3Schema)).optional(),
});

export const BackendUserSchema = z.object({
    id: z.string(),
    username: z.string(),
    password: z.string(),
    lastFMSessionKey: z.string().optional(),
    listenbrainzToken: z.string().optional(),
});

export const UserSchema = z.object({
    backend: BackendUserSchema,
    subsonic: SubsonicUserSchema,
});

export const PlaylistSchema = z.object({
    id: z.string(),
    name: z.string(),
    owner: z.string(),
    public: z.boolean().default(false),
    created: z.date(),
    changed: z.date(),
    songCount: z.number(),
    duration: z.number(),
    entry: z.array(z.string().or(SongID3Schema)).default([]),
    comment: z.string().optional(),
    coverArt: z.string().optional(),
});

export type userData = z.infer<typeof userDataSchema>;
export type CoverArt = z.infer<typeof CoverArtSchema>;
export type ConfigTranscodingOption = z.infer<typeof ConfigTranscodingOptionSchema>;
export type ConfigLastFMOption = z.infer<typeof ConfigLastFMOptionSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type ReplayGain = z.infer<typeof ReplayGainSchema>;
export type Contributor = z.infer<typeof ContributorSchema>;
export type Genre = z.infer<typeof GenreSchema>;
export type RecordLabel = z.infer<typeof RecordLabelSchema>;
export type AlbumReleaseDate = z.infer<typeof AlbumReleaseDateSchema>;
export type StructuredLyrics = z.infer<typeof StructuredLyricsSchema>;
export type DiscTitles = z.infer<typeof DiscTitlesSchema>;
export type AlbumID3Artists = z.infer<typeof AlbumID3ArtistsSchema>;
export type AlbumID3 = z.infer<typeof AlbumID3Schema>;
export type Album = z.infer<typeof AlbumSchema>;
export type ArtistInfo = z.infer<typeof ArtistInfoSchema>;
export type Artist = z.infer<typeof ArtistSchema>;
export type ArtistID3 = z.infer<typeof ArtistID3Schema>;
export type Song = z.infer<typeof SongSchema>;
export type SongID3 = z.infer<typeof SongID3Schema>;
export type PlayQueue = z.infer<typeof PlayQueueSchema>;
export type SubsonicUser = z.infer<typeof SubsonicUserSchema>;
export type BackendUser = z.infer<typeof BackendUserSchema>;
export type User = z.infer<typeof UserSchema>;
export type Playlist = z.infer<typeof PlaylistSchema>;
export interface nowPlaying {
    track: SongID3;
    minutesAgo: Date;
    username: string;
    playerName: string;
}
