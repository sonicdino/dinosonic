import { z } from "https://deno.land/x/zod@v3.24.2/mod.ts";

export const CoverArtSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  path: z.string()
})

export const ConfigTranscodingOptionSchema = z.object({
  enabled: z.boolean().optional(),
  ffmpeg_path: z.string().default("ffmpeg"),
});

export const ConfigLastFMOptionSchema = z.object({
  enabled: z.boolean().optional(),
  enable_scrobbling: z.boolean().default(true),
  api_key: z.string().optional(),
  api_secret: z.string().optional(),
});

export const ConfigSchema = z.object({
  port: z.union([z.number(), z.string()]),
  enable_logging: z.boolean().default(false),
  data_folder: z.string(),
  transcoding: ConfigTranscodingOptionSchema.optional(),
  last_fm: ConfigLastFMOptionSchema.optional(),
  music_folders: z.array(z.string()),
  scan_on_start: z.boolean().default(false),
  default_admin_password: z.string(),
});

export const ReplayGainSchema = z.object({
  trackGain: z.number().optional(),
  trackPeak: z.number().optional(),
  albumGain: z.number().optional(),
  albumPeak: z.number().optional(),
  baseGain: z.number().optional(),
  fallbackGain: z.number().optional()
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
  name: z.string()
})

export const SongSchema = z.object({
  backend: z.object({
    lastModified: z.number(),
    lastFM: z.boolean().default(false)
  }),
  subsonic: z.object({
    id: z.string(),
    parent: z.string().optional(),
    isDir: z.boolean().default(false),
    title: z.string(),
    album: z.string().optional(),
    artist: z.string().optional(),
    track: z.number().optional(),
    year: z.number().optional(),
    genre: z.string().optional(),
    coverArt: z.string().optional(),
    size: z.bigint().optional(),
    contentType: z.string().optional(),
    suffix: z.string().optional(),
    transcodedContentType: z.string().optional(),
    transcodedSuffix: z.string().optional(),
    duration: z.number().optional(),
    bitRate: z.number().optional(),
    bitDepth: z.number().optional(),
    samplingRate: z.number().optional(),
    channelCount: z.number().optional(),
    path: z.string().optional(),
    isVideo: z.boolean().optional(),
    userRating: z.number().min(1).max(5).optional(),
    averageRating: z.number().min(1.0).max(5.0).optional(),
    playCount: z.bigint().optional(),
    discNumber: z.number().optional(),
    created: z.string().optional(),
    starred: z.string().optional(),
    albumId: z.string().optional(),
    artistId: z.string().optional(),
    type: z.string().optional(),
    mediaType: z.string().optional(),
    bookmarkPosition: z.bigint().optional(),
    originalWidth: z.number().optional(),
    originalHeight: z.number().optional(),
    played: z.string().optional(),
    bpm: z.number().optional(),
    comment: z.string().optional(),
    sortName: z.string().optional(),
    musicBrainzId: z.string().optional(),
    genres: z.array(GenreSchema).optional(),
    artists: z.array(AlbumID3ArtistsSchema).optional(),
    displayArtist: z.string().optional(),
    albumArtists: z.array(AlbumID3ArtistsSchema).optional(),
    displayAlbumArtist: z.string().optional(),
    contributors: z.array(ContributorSchema).optional(),
    displayComposer: z.string().optional(),
    moods: z.array(z.string()).optional(),
    replayGain: ReplayGainSchema.optional(),
    explicitStatus: z.enum(["explicit", "clean", ""]).optional(),
  }),
});

export const AlbumID3Schema = z.object({
  id: z.string(),
  name: z.string(),
  artist: z.string().optional(),
  year: z.number().optional(),
  coverArt: z.string().optional(),
  starred: z.date().optional(),
  duration: z.number(),
  playCount: z.number().optional(),
  genre: z.string().optional(),
  created: z.string(),
  artistId: z.string().optional(),
  songCount: z.number(),
  played: z.date().optional(),
  userRating: z.number().optional(),
  recordLabels: z.array(RecordLabelSchema).optional(),
  musicBrainzId: z.string().optional(),
  genres: z.array(GenreSchema).optional(),
  artists: z.array(AlbumID3ArtistsSchema).optional(),
  displayArtist: z.string().optional(),
  releaseTypes: z.array(z.string()).optional(),
  moods: z.array(z.string()).optional(),
  sortName: z.string().optional(),
  originalReleaseDate: AlbumReleaseDateSchema.optional(),
  releaseDate: AlbumReleaseDateSchema.optional(),
  isCompilation: z.boolean().optional(),
  explicitStatus: z.string().optional(),
  discTitles: z.array(DiscTitlesSchema).default([]),
  song: z.array(z.string().or(SongSchema)).default([])
});

export const ArtistID3Schema = z.object({
  id: z.string(),
  name: z.string(),
  coverArt: z.string().optional(),
  artistImageUrl: z.string().optional(),
  albumCount: z.number().optional(),
  starred: z.string().optional(),
  musicBrainzId: z.string().optional(),
  sortName: z.string().optional(),
  roles: z.array(z.string()).optional(),
  album: z.array(z.string().or(AlbumID3Schema)).default([])
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
  streamRole: z.boolean(),
  jukeboxRole: z.boolean().default(false),
  shareRole: z.boolean().default(false),
  avatarLastChanged: z.date().optional(),
  folder: z.array(z.string()).optional(),
});

export const BackendUserSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const UserSchema = z.object({
  backend: BackendUserSchema,
  subsonic: SubsonicUserSchema,
});

export type CoverArt = z.infer<typeof CoverArtSchema>;
export type ConfigTranscodingOption = z.infer<typeof ConfigTranscodingOptionSchema>;
export type ConfigLastFMOption = z.infer<typeof ConfigLastFMOptionSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type ReplayGain = z.infer<typeof ReplayGainSchema>;
export type Contributor = z.infer<typeof ContributorSchema>;
export type Genre = z.infer<typeof GenreSchema>;
export type RecordLabel = z.infer<typeof RecordLabelSchema>;
export type AlbumReleaseDate = z.infer<typeof AlbumReleaseDateSchema>;
export type DiscTitles = z.infer<typeof DiscTitlesSchema>;
export type AlbumID3Artists = z.infer<typeof AlbumID3ArtistsSchema>;
export type AlbumID3 = z.infer<typeof AlbumID3Schema>;
export type ArtistID3 = z.infer<typeof ArtistID3Schema>;
export type Song = z.infer<typeof SongSchema>;
export type SubsonicUser = z.infer<typeof SubsonicUserSchema>;
export type BackendUser = z.infer<typeof BackendUserSchema>;
export type User = z.infer<typeof UserSchema>;