# Dinosonic

Dinosonic is a fast, lightweight music streaming server built with Deno,
inspired by the Subsonic API.

## Features  

- **Subsonic API Compatibility** – Works with Subsonic clients  
- **Metadata Extraction** – Uses FFmpeg to retrieve music metadata  
- **Cover Art Support** – Stores and serves album covers efficiently  
- **Last.fm & Spotify Integration** – Supports OAuth-based Last.fm scrobbling and Spotify metadata fetching  
- **Admin Panel** – Web interface for managing scrobbling, transcoding profiles (TBA), and stats (TBA)
- **Docker Support** – Easy deployment with environment variables
- **Standalone Executable** – Runs as a single executable with no dependencies  

## Installation  

### Running with Docker  

```sh
docker run -d --name dinosonic \
  -p 4100:4100 \
  -v /path/to/music:/music:ro \
  -v /path/to/data:/data \
  -e DINO_PORT=4100 \
  -e DINO_LOG_LEVEL=INFO \
  -e DINO_DATA_FOLDER=/config \
  -e DINO_MUSIC_FOLDERS=/music \
  -e DINO_SCAN_ON_START=true \
  -e DINO_SCAN_INTERVAL=1d \
  -e DINO_DEFAULT_ADMIN_PASSWORD=admin \
  ghcr.io/sonicdino/dinosonic:latest
```

Or as a docker compose
```yaml
services:
  dinosonic:
    image: ghcr.io/sonicdino/dinosonic:latest
    container_name: dinosonic
    restart: unless-stopped
    ports:
      - "4100:4100"
    volumes:
      - /path/to/music:/music:ro
      - /path/to/data:/data
    environment:
      DINO_PORT: 4100
      DINO_LOG_LEVEL: INFO
      DINO_DATA_FOLDER: /config
      DINO_MUSIC_FOLDERS: /music
      DINO_SCAN_ON_START: true
      DINO_SCAN_INTERVAL: 1d
      DINO_DEFAULT_ADMIN_PASSWORD: admin
```

#### Optional Environment Variables  

| Variable                    | Description                                   | Default |
|-----------------------------|-----------------------------------------------|---------|
| `DINO_PORT`                 | Server port                                  | `4100`  |
| `DINO_LOG_LEVEL`            | Logging level (`OFF`, `INFO`, `DEBUG`)       | `OFF`   |
| `DINO_DATA_FOLDER`          | Path for storing metadata & database         | *Required* |
| `DINO_MUSIC_FOLDERS`        | Semicolon-separated list of music folders    | `[]` |
| `DINO_SCAN_ON_START`        | Scan music library on startup (`true/false`) | `false` |
| `DINO_SCAN_INTERVAL`        | Interval for rescanning (e.g., `1d`, `12h`, `1hr 25m 10s`)  | `1d`    |
| `DINO_DEFAULT_ADMIN_PASSWORD` | Default password for admin panel. Only needed for the first initialization of dinosonic. | `adminPassword` |
| `DINO_LASTFM_ENABLED`       | Enable Last.fm integration (`true/false`)    | `false` |
| `DINO_LASTFM_SCROBBLING`    | Enable Last.fm scrobbling (`true/false`)     | `false` |
| `DINO_LASTFM_APIKEY`        | Last.fm API key. \*Required if LastFM is enabled. | *None\**  |
| `DINO_LASTFM_APISECRET`     | Last.fm API secret. \*Required if LastFM Scrobbling is enabled.  | *None\**  |
| `DINO_SPOTIFY_ENABLED`      | Enable Spotify integration for artist cover art. (`true/false`)    | `false` |
| `DINO_SPOTIFY_CLIENT_ID`    | Spotify Client ID. \*Required if spotify is enabled. | *None\**  |
| `DINO_SPOTIFY_CLIENT_SECRET` | Spotify Client Secret. \*Required if spotify is enabled. | *None\**  |
| `DINO_TRANSCODING_ENABLED`  | Enable FFmpeg-based transcoding (`true/false`) | `false` |
| `DINO_FFMPEG_PATH`          | Path to `ffmpeg` binary                      | `ffmpeg` |

---

### Running as a Standalone Executable  

<details>
<summary><strong>Linux/macOS</strong></summary>

```sh
chmod +x dinosonic
./dinosonic --config /path/to/config
```
</details>

<details>
<summary><strong>Windows</strong></summary>

```powershell
dinosonic.exe --config "C:\path\to\config"
```
</details>

<details>
<summary><strong>Config File</strong></summary>

```toml
port = 4100
log_level = "DEBUG"
data_folder = "/path/to/dataDir"
music_folders = [ "/path/to/music", "/path/to/music2" ]
default_admin_password = "adminPassword"
scan_on_start = true

[transcoding]
enabled = false
ffmpeg_path = "ffmpeg"

[last_fm]
enabled = true
api_key = "apiKey"
api_secret = "apiSecret"

[spotify]
enabled = true
client_id = "clientId"
client_secret = "clintSecret"
```

#### Config File Options
| Option                  | Type     | Default  | Description |
|-------------------------|----------|----------|-------------|
| `port`                  | number   | `4100`   | The port on which Dinosonic runs. |
| `log_level`             | string   | `OFF`    | Logging level (e.g., `DEBUG`, `INFO`). |
| `data_folder`           | string   | *Required*   | Path to store metadata and other data. |
| `music_folders`         | array    | `[]`     | List of directories containing music. |
| `scan_on_start`         | boolean  | `false`  | Whether to scan the music folder on startup. |
| `scan_interval`         | string   | `1d`     | Interval between automatic scans. |
| `default_admin_password`| string   | `adminPassword`   | The default password for the admin account. Only needed for the first initialization of dinosonic. |

#### Transcoding Options
| Option      | Type    | Default  | Description |
|------------|---------|----------|-------------|
| `enabled`  | boolean | `false`  | Whether transcoding is enabled. |
| `ffmpeg_path` | string | `ffmpeg` | Path to the FFmpeg executable. |

#### Last.fm Options
| Option             | Type    | Default  | Description |
|--------------------|---------|----------|-------------|
| `enabled`         | boolean | *None*   | Whether Last.fm integration is enabled. |
| `enable_scrobbling` | boolean | `false`  | Whether to enable Last.fm scrobbling. |
| `api_key`         | string  | *None\**   | Last.fm API key. \*Required if LastFM is enabled. |
| `api_secret`      | string  | *None\**   | Last.fm API secret. \*Required if LastFM scrobbling is enabled. |

#### Spotify Options
| Option       | Type    | Default  | Description |
|-------------|---------|----------|-------------|
| `enabled`   | boolean | `false`  | Whether Spotify integration is enabled. |
| `client_id` | string  | *None\**   | Spotify client ID. \*Required if spotify is enabled. |
| `client_secret` | string | *None\** | Spotify client secret. \*Required if spotify is enabled. |
</details>

---

## API & Admin Panel  

- **Subsonic API** – Compatible with existing Subsonic clients  
- **Admin Panel** – Available at [`http://localhost:4100/admin/`](http://localhost:4100/admin/)  

---

## Roadmap  

- **ListenBrainz Scrobbling**
- **LastFM Scrobbling**
- **Device-Specific Transcoding Profiles**  
- **Custom front-end set by the admin**

---

## Contributing  

Feel free to contribute by submitting issues, feature requests, or pull requests at [Dinosonic Repository](https://git.rapidfuge.com/rapidfuge/dinosonic).  

---

## License  

Dinosonic is licensed under the **GNU General Public License v3 (GPLv3)**.
