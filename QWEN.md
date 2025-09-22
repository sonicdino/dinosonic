# Dinosonic - Context Information for Qwen Code

## Project Overview

Dinosonic is a fast, lightweight music streaming server built with Deno, inspired by the Subsonic API. It allows users to stream their personal music collection through a web interface and compatible Subsonic clients.

### Key Technologies
- **Runtime**: Deno
- **Language**: TypeScript
- **Web Framework**: Hono
- **Database**: Deno KV (key-value store)
- **Metadata Parsing**: music-metadata npm package
- **Containerization**: Docker

### Core Features
- Subsonic API Compatibility with OpenSubsonic extensions
- Metadata extraction from music files
- Cover art management and external fetching (Last.fm, Spotify)
- Lyrics support (synced and unsynced)
- Last.fm integration (metadata, scrobbling, loved track sync)
- Spotify integration (artist cover art)
- ListenBrainz scrobbling support
- User-specific data tracking (starred items, play counts, ratings)
- Admin panel for user and system management
- Docker support for easy deployment
- Standalone executable compilation

## Project Structure

```
.
├── src/                    # Source code
│   ├── client/            # Frontend assets (admin panel, share pages)
│   ├── main.ts            # Entry point
│   ├── zod.ts             # Schema definitions and types
│   ├── MediaScanner.ts    # Music library scanning and metadata extraction
│   ├── LastFM.ts          # Last.fm API integration
│   ├── Spotify.ts         # Spotify API integration
│   ├── ListenBrainz.ts    # ListenBrainz API integration
│   ├── MusixMatch.ts      # Lyrics fetching (not fully implemented)
│   ├── PlaylistManager.ts # Playlist functionality
│   ├── player.ts          # Audio playback functionality
│   └── util.ts            # Utility functions
├── dist/                  # Compiled executables
├── ui/                    # Custom frontend (optional)
├── deno.json              # Project configuration and build tasks
├── Dockerfile             # Docker image definition
├── README.md              # Project documentation
└── LICENSE                # GPL v3 license
```

## Configuration

Dinosonic can be configured through:
1. Environment variables
2. TOML config file
3. Command line arguments

### Key Configuration Options
- Port, log level, data folder
- Music folders to scan
- Scan intervals and startup behavior
- Artist/genre tag separators
- External service credentials (Last.fm, Spotify)
- Transcoding settings (requires FFmpeg)

## Development Workflow

### Prerequisites
- Deno 1.40+
- FFmpeg (optional, for transcoding)

### Running Locally
1. Install Deno: https://deno.land/
2. Clone the repository
3. Run with default settings:
   ```bash
   deno task dev
   ```

### Building
Dinosonic can be compiled into standalone executables for different platforms:
- `deno task build` - Build for current platform
- `deno task build:linux` - Build for Linux x86_64
- `deno task build:mac` - Build for macOS x86_64
- `deno task build:windows` - Build for Windows x86_64

### Docker
Pre-built Docker images are available at `ghcr.io/sonicdino/dinosonic`

To build locally:
```bash
docker build -t dinosonic .
```

## API Structure

### Main Entry Points
- `/` - Server status
- `/rest` - Subsonic API endpoints
- `/api` - Extended API endpoints
- `/admin` - Administrative interface
- `/public` - Static assets
- `/share/:id` - Public share links

### Authentication
- Subsonic API uses token or password authentication
- Admin panel uses JWT tokens

## Data Model

Dinosonic uses Deno KV for data storage with the following key entities:
- Users (with subsonic and backend data)
- Songs (with metadata and backend info)
- Albums (with metadata and backend info)
- Artists (with metadata)
- Playlists
- Cover art
- Shares (public links)
- Now playing status

All entities are defined with Zod schemas in `src/zod.ts` for validation.

## External Integrations

### Last.fm
- Metadata fetching for albums and artists
- Scrobbling support with OAuth
- Loved track synchronization

### Spotify
- Artist cover art fetching

### ListenBrainz
- Scrobbling support

## Testing

Currently, there are no automated tests in the project. Testing is done manually through:
- API endpoint verification
- UI testing in admin panel
- Client compatibility testing

## Deployment

### Docker Deployment (Recommended)
```bash
docker run -d --name dinosonic \
  -p 4100:4100 \
  -v /path/to/music:/music:ro \
  -v /path/to/data:/data \
  -e DINO_PORT=4100 \
  -e DINO_DATA_FOLDER=/data \
  -e DINO_MUSIC_FOLDERS=/music \
  ghcr.io/sonicdino/dinosonic:latest
```

### Standalone Executable
After building, run the executable directly with environment variables or a config file.

## Contributing

The project welcomes contributions through GitHub issues and pull requests.