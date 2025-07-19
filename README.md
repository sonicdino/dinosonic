# Dinosonic
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=flat-square)](https://www.gnu.org/licenses/gpl-3.0)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/sonicdino/dinosonic/build-release.yml?style=flat-square&logo=github&label=Build%20and%20Release%20Dinosonic&color=blue)](https://github.com/sonicdino/dinosonic/actions/workflows/build-release.yml)
[![Docker Image](https://img.shields.io/badge/docker-ghcr.io/sonicdino/dinosonic-blue?style=flat-square&logo=docker)](https://github.com/users/sonicdino/packages/container/package/dinosonic)

Dinosonic is a fast, lightweight music streaming server built with Deno,
inspired by the Subsonic API.

## Features

-   **Subsonic API Compatibility** – Works with many Subsonic clients.
-   **Metadata Extraction** – Uses built-in parsers and FFmpeg (optional for some formats) to retrieve music metadata.
-   **Cover Art Support** – Stores and serves album covers efficiently, including fetching from Last.fm and Spotify for artists.
-   **Lyrics Support** – Fetches and serves both synced (LRC) and unsynced lyrics for tracks.
-   **Last.fm Integration**:
    -   Fetches album and artist metadata from Last.fm.
    -   Supports OAuth-based Last.fm scrobbling on a per-user basis.
    -   Synchronizes local starred tracks with Last.fm "loved" tracks, respecting timestamps for conflict resolution. Star/unstar actions in Dinosonic can immediately update Last.fm.
-   **Spotify Integration** – Fetches artist cover art from Spotify.
-   **User-Specific Data** – Tracks starred items, play counts, and ratings per user.
-   **Admin Panel** – Web interface for:
    -   Managing users (create, edit permissions, delete).
    -   Linking/unlinking user Last.fm accounts for scrobbling and sync.
-   **Docker Support** – Easy deployment with environment variables.
-   **Standalone Executable** – Runs as a single executable with no external runtime dependencies (once compiled).

## Installation

### Running with Docker (Recommended)

```sh
docker run -d --name dinosonic \
  -p 4100:4100 \
  -v /path/to/music:/music:ro \
  -v /path/to/data:/data \
  -e DINO_PORT=4100 \
  -e DINO_LOG_LEVEL=INFO \
  -e DINO_DATA_FOLDER=/data \
  -e DINO_MUSIC_FOLDERS=/music \
  -e DINO_SCAN_ON_START=true \
  -e DINO_SCAN_INTERVAL=1d \
  -e DINO_ARTIST_SEPARATORS=';/' \
  -e DINO_GENRE_SEPARATORS=';,' \
  -e DINO_DEFAULT_ADMIN_PASSWORD=admin \
  ghcr.io/sonicdino/dinosonic:latest
```

Or as a docker compose:

```yaml
services:
    dinosonic:
        image: ghcr.io/sonicdino/dinosonic:latest
        container_name: dinosonic
        restart: unless-stopped
        ports:
            - '4100:4100'
        volumes:
            - /path/to/music:/music:ro
            - /path/to/data:/data
            #- /path/to/ui:/ui:ro # If you're planning to have a custom frontend at /
        environment:
            DINO_PORT: 4100
            DINO_LOG_LEVEL: INFO
            DINO_DATA_FOLDER: /data
            DINO_MUSIC_FOLDERS: /music
            DINO_SCAN_ON_START: true
            DINO_SCAN_INTERVAL: 1d
            DINO_ARTIST_SEPARATORS: ';/'
            DINO_GENRE_SEPARATORS: ';,'
            DINO_DEFAULT_ADMIN_PASSWORD: admin
            # Optional configuration variable
            # DINO_UI_FOLDER: /ui
            # Optional Last.fm variables
            # DINO_LASTFM_ENABLED: true
            # DINO_LASTFM_SCROBBLING: true
            # DINO_LASTFM_APIKEY: your_lastfm_api_key
            # DINO_LASTFM_APISECRET: your_lastfm_api_secret
            # Optional Spotify variables
            # DINO_SPOTIFY_ENABLED: true
            # DINO_SPOTIFY_CLIENT_ID: your_spotify_client_id
            # DINO_SPOTIFY_CLIENT_SECRET: your_spotify_client_secret
            # Optional Transcoding variables
            # DINO_TRANSCODING_ENABLED: false
            # DINO_FFMPEG_PATH: ffmpeg
```

#### Environment Variables

| Variable                      | Description                                                                                | Default         |
| ----------------------------- | ------------------------------------------------------------------------------------------ | --------------- |
| `DINO_PORT`                   | Server port                                                                                | `4100`          |
| `DINO_LOG_LEVEL`              | Logging level (`OFF`, `INFO`, `DEBUG`, `WARNING`, `ERROR`)                                 | `OFF`           |
| `DINO_DATA_FOLDER`            | Path for storing metadata, database, and covers.                                           | _Required_      |
| `DINO_UI_FOLDER`              | Custom UI Frontend folder containing the static HTML, CSS, and JS.                         | None            |
| `DINO_MUSIC_FOLDERS`          | Semicolon-separated list of music folders (e.g., `/music;/more_music`).                    | `[]`            |
| `DINO_SCAN_ON_START`          | Scan music library on startup (`true`/`false`).                                            | `false`         |
| `DINO_SCAN_INTERVAL`          | Interval for rescanning (e.g., `1d`, `12h`, `1hr 25m 10s`).                                | `1d`            |
| `DINO_ARTIST_SEPARATORS`      | Characters used to separate multiple artists in tags (e.g., `';/'`).                       | `';/'`          |
| `DINO_GENRE_SEPARATORS`       | Characters used to separate multiple genres in tags (e.g., `';,'`).                        | `';,'`          |
| `DINO_DEFAULT_ADMIN_PASSWORD` | Default password for the 'admin' user. Only used for the first initialization.             | `adminPassword` |
| `DINO_LASTFM_ENABLED`         | Enable Last.fm metadata fetching (`true`/`false`).                                         | `false`         |
| `DINO_LASTFM_SCROBBLING`      | Enable Last.fm scrobbling and loved track sync (`true`/`false`). (Implies Last.fm enabled) | `false`         |
| `DINO_LASTFM_APIKEY`          | Last.fm API key. \*Required if `DINO_LASTFM_ENABLED` or `DINO_LASTFM_SCROBBLING` is true.  | _None\*_        |
| `DINO_LASTFM_APISECRET`       | Last.fm API secret. \*Required if `DINO_LASTFM_SCROBBLING` is true.                        | _None\*_        |
| `DINO_SPOTIFY_ENABLED`        | Enable Spotify integration for artist cover art (`true`/`false`).                          | `false`         |
| `DINO_SPOTIFY_CLIENT_ID`      | Spotify Client ID. \*Required if `DINO_SPOTIFY_ENABLED` is true.                           | _None\*_        |
| `DINO_SPOTIFY_CLIENT_SECRET`  | Spotify Client Secret. \*Required if `DINO_SPOTIFY_ENABLED` is true.                       | _None\*_        |
| `DINO_TRANSCODING_ENABLED`    | Enable FFmpeg-based transcoding for streaming and cover art resizing (`true`/`false`).     | `false`         |
| `DINO_FFMPEG_PATH`            | Path to `ffmpeg` binary.                                                                   | `ffmpeg`        |

---

### Running as a Standalone Executable

You can compile Dinosonic into a single executable for various platforms. Build tasks are defined in `deno.json` (e.g., `deno task build:linux`, `deno task build`).

<details>
<summary><strong>Command Line Arguments</strong></summary>

Dinosonic supports the following command-line arguments:

```sh
dinosonic [OPTIONS...]
```

-   `-h, --help`: Display help and exit.
-   `-v, --version`: Display the current version of Dinosonic.
-   `-c, --config /path/to/config.toml`: Set the config file location. If not provided, Dinosonic will try to use environment variables.

</details>

<details>
<summary><strong>Linux/macOS</strong></summary>

```sh
# Make sure the compiled binary is executable
chmod +x dinosonic-linux-x86 # or dinosonic-mac-x86, etc.

# Run with a config file
./dinosonic-linux-x86 --config /path/to/your/config.toml

# Or run using environment variables (see Docker section for variables)
# export DINO_DATA_FOLDER=/data
# export DINO_MUSIC_FOLDERS=/music
# ... and so on
# ./dinosonic-linux-x86
```

</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
# Run with a config file
.\dinosonic-win-x86.exe --config "C:\\path\\to\\your\\config.toml"

# Or run using environment variables (see Docker section for variables)
# $env:DINO_DATA_FOLDER = "C:\\dinosonic_data"
# $env:DINO_MUSIC_FOLDERS = "C:\\music"
# ... and so on
# .\\dinosonic-win-x86.exe
```

</details>

<details>
<summary><strong>Config File (`config.toml`)</strong></summary>

If you prefer, you can use a TOML configuration file instead of environment variables when running the standalone executable.

```toml
port = 4100
log_level = "INFO" # Options: "OFF", "DEBUG", "INFO", "WARNING", "ERROR"
data_folder = "/path/to/dataDir"
ui_folder = "/path/to/ui" # If you plan on having a custom frontend
music_folders = [ "/path/to/music", "/path/to/another/music_folder" ]
default_admin_password = "yourSecureAdminPassword" # Only used on first run
scan_on_start = true
scan_interval = "1d" # e.g., "1d", "12h", "30m"
artist_separators = [";", "/"]
genre_separators = [";", ","]

[transcoding]
enabled = false
ffmpeg_path = "ffmpeg" # Path to ffmpeg binary

[last_fm]
enabled = false # For metadata fetching
enable_scrobbling = false # For scrobbling and loved track sync (implies 'enabled' is true)
api_key = "your_lastfm_api_key"
api_secret = "your_lastfm_api_secret" # Required if enable_scrobbling is true

[spotify]
enabled = false # For artist image fetching
client_id = "your_spotify_client_id"
client_secret = "your_spotify_client_secret"
```

#### Config File Options

| Option                   | Type    | Default         | Description                                                                          |
| ------------------------ | ------- | --------------- | ------------------------------------------------------------------------------------ |
| `port`                   | number  | `4100`          | The port on which Dinosonic runs.                                                    |
| `log_level`              | string  | `OFF`           | Logging level (e.g., `OFF`, `DEBUG`, `INFO`, `WARNING`, `ERROR`).                    |
| `data_folder`            | string  | _Required_      | Path to store metadata, database, and covers.                                        |
| `ui_folder`              | string  | None            | Custom UI Frontend folder containing the static HTML, CSS, and JS.                   |
| `music_folders`          | array   | `[]`            | List of directories containing music.                                                |
| `scan_on_start`          | boolean | `false`         | Whether to scan the music library on startup.                                        |
| `scan_interval`          | string  | `1d`            | Interval for rescanning (e.g., `1d`, `12h`, `30m`, `1h 30m 10s`).                    |
| `artist_separators`      | array   | `[';', '/']`    | Characters used to split multiple artists in tags.                                   |
| `genre_separators`       | array   | `[';', ',']`    | Characters used to split multiple genres in tags.                                    |
| `default_admin_password` | string  | `adminPassword` | The default password for the 'admin' user. Only needed for the first initialization. |

#### Transcoding Options (`[transcoding]`)

| Option        | Type      | Default  | Description                                                |
| ------------- | --------- | -------- | ---------------------------------------------------------- |
| `enabled`     | boolean   | `false`  | Whether FFmpeg-based transcoding for streaming is enabled. |
| `ffmpeg_path` | string    | `ffmpeg` | Path to the FFmpeg executable.                             |
| <!--          | `enabled` | boolean  | `false`                                                    | Whether FFmpeg-based transcoding for streaming/cover resizing is enabled. | --> |

#### Last.fm Options (`[last_fm]`)

| Option              | Type    | Default  | Description                                                                                   |
| ------------------- | ------- | -------- | --------------------------------------------------------------------------------------------- |
| `enabled`           | boolean | `false`  | Enable Last.fm metadata fetching (artist/album info).                                         |
| `enable_scrobbling` | boolean | `false`  | Enable Last.fm scrobbling and loved track sync. If true, `enabled` is also considered true.   |
| `api_key`           | string  | _None\*_ | Last.fm API key. \*Required if `enabled` or `enable_scrobbling` is true.                      |
| `api_secret`        | string  | _None\*_ | Last.fm API secret. \*Required if `enable_scrobbling` is true for OAuth and signed API calls. |

#### Spotify Options (`[spotify]`)

| Option          | Type    | Default  | Description                                                        |
| --------------- | ------- | -------- | ------------------------------------------------------------------ |
| `enabled`       | boolean | `false`  | Whether Spotify integration for fetching artist images is enabled. |
| `client_id`     | string  | _None\*_ | Spotify client ID. \*Required if `enabled` is true.                |
| `client_secret` | string  | _None\*_ | Spotify client secret. \*Required if `enabled` is true.            |

</details>

---

## API & Admin Panel

-   **Subsonic API** – Compatible with existing Subsonic clients. Key OpenSubsonic extensions like `formPost`, `songLyrics`, and `transcodeOffset` are supported.
-   **Admin Panel** – Available at `http://localhost:<DINO_PORT>/admin/`.
    -   Manage users: create, edit permissions (admin, settings, download, stream, scrobbling, etc.), delete.
    -   Link/Unlink personal Last.fm account for scrobbling and loved track synchronization.
    -   View server status and version.

---

## Roadmap

-   **ListenBrainz Scrobbling**
-   **Custom front-end theme/styling options set by the admin**
-   **More detailed statistics in the Admin Panel**
<!-- -   **Device-Specific Transcoding Profiles** (currently global or per-request) -->

---

## Contributing

Feel free to contribute by submitting issues, feature requests, or pull requests at the [Dinosonic GitHub Repository](https://github.com/sonicdino/dinosonic).

---

## License

Dinosonic is licensed under the [**GNU General Public License v3 (GPLv3)**](https://www.gnu.org/licenses/gpl-3.0).
