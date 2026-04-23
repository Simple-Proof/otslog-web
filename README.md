# otslog-web

A web interface and API for `otslog`, providing live video streaming alongside real-time OpenTimestamps activity. It allows users to monitor a growing log file, view its live HLS video representation, and extract timestamped snapshots with their corresponding proofs.

## Overview

`otslog-web` acts as a bridge between the `otslog` CLI and a web browser. It handles:
- Spawning and managing `ffmpeg` (RTSP → MP4 segments + HLS streaming).
- Auto-starting `otslog stamp --follow` on the growing MP4 files.
- Serving HLS video segments for live playback.
- Streaming real-time `otslog stamp --follow` output via WebSockets.
- Providing a REST API for listing and extracting snapshots.
- A single-page dashboard for monitoring and interaction.

## Architecture

```text
+----------------+      +----------------+      +----------------+
|     ffmpeg     |----->|  segments/     |<-----|     otslog     |
| (dual process) |      | output_*.mp4   |      | (stamp --follow)|
+-------+--------+      +-------+--------+      +-------+--------+
        |                       ^                       |
        v                       |                       v
+-------+--------+      +-------+--------+      +-------+--------+
|   hls/ dir     |      |   otslog-web   |      |  .otslog       |
| (.m3u8, .ts)   |<-----|   (Bun/Hono)   |----->| (Metadata)     |
+-------+--------+      +-------+--------+      +-------+--------+
        |                       ^
        |                       |
        v                       v
+----------------------------------------------------------------+
|                        Web Browser                             |
|           (HLS Player + otslog Dashboard)                      |
+----------------------------------------------------------------+
```

## Prerequisites

- **Bun**: Fast JavaScript runtime and package manager.
- **otslog**: The Rust-based CLI tool for OpenTimestamps logging.
- **ffmpeg**: Used to generate HLS segments and the source MP4 file.

## Quick Start (Raspberry Pi)

### 1. Clone and setup

```bash
git clone <repository> otslog-web
cd otslog-web
./install.sh --with-service
```

This installs ffmpeg, bun (if missing), makes otslog executable, and sets up auto-start on boot.

### 2. Configure camera

Edit `.env` with your RTSP URL:

```bash
nano .env
```

Set `RTSP_URL=rtsp://admin:password@your-camera-ip:554/stream`

### 3. Start the service

```bash
# Start in background (auto-restarts on reboot via systemd)
sudo systemctl start otslog-web

# Check status
sudo systemctl status otslog-web

# View logs
tail -f otslog-web.log
```

### 4. Open dashboard

Navigate to `http://<raspberry-ip>:3777`

## Manual Operation

If you prefer to run without systemd:

```bash
# Install dependencies only (no auto-start)
./install.sh

# Start in background manually
./start.sh start

# Check status
./start.sh status

# Stop
./start.sh stop

# Restart
./start.sh restart
```

## Configuration (.env)

Copy `.env.example` to `.env` and customize:

```bash
cp .env.example .env
nano .env
```

### Single Camera

```env
RTSP_URL=rtsp://admin:password@192.168.1.100:554/stream
```

### Multiple Cameras

```env
CAMERAS=cam01,cam02,cam03

# Camera 1
CAM01_RTSP_URL=rtsp://192.168.1.101:554/stream
CAM01_NAME="Front Door"

# Camera 2
CAM02_RTSP_URL=rtsp://192.168.1.102:554/stream
CAM02_NAME="Backyard"

# Camera 3
CAM03_RTSP_URL=rtsp://192.168.1.103:554/stream
CAM03_NAME="Garage"
```

### External HLS Stream (per camera)

```env
CAM01_HLS_URL=https://hls-server.com/cam01/live.m3u8
```

### OpenTimestamps Calendars (aggregators)

```env
STAMP_AGGREGATORS=https://alice.btc.calendar.opentimestamps.org/digest,https://bob.btc.calendar.opentimestamps.org/digest
```

| Variable | Default | Description |
|----------|---------|-------------|
| `RTSP_URL` | *(required)* | Full RTSP URL with credentials |
| `CAMERAS` | *(none)* | Comma-separated camera IDs for multi-camera |
| `{CAM}_RTSP_URL` | *(required per camera)* | RTSP URL for specific camera |
| `{CAM}_NAME` | *(camera ID)* | Display name for camera |
| `{CAM}_HLS_URL` | *(auto)* | External HLS URL (optional) |
| `PORT` | `3777` | Web server port |
| `SEGMENTS_DIR` | `./segments` | Segment storage directory |
| `SEGMENT_TIME` | `30` | Segment rotation time (seconds) |
| `FOLLOW_INTERVAL` | `1` | otslog stamp follow interval (seconds) |
| `IDLE_TIMEOUT` | `40` | Idle timeout before stopping stamp (seconds) |
| `STAMP_AGGREGATORS` | *(see above)* | Comma-separated calendar URLs |
| `STAMP_TIMEOUT_SECONDS` | `30` | Timeout for stamping operations |
| `STAMP_MIN_ATTESTATIONS` | `1` | Minimum attestations required |

## CLI Arguments

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--port` | Port to run the server on | `3777` |
| `--otslog-bin` | Path to the `otslog` binary | *(required)* |
| `--segment-time` | Segment rotation time in seconds | `600` |
| `--no-ffmpeg` | Disable auto-starting ffmpeg | `false` |
| `--no-stamp` | Disable auto-starting otslog stamp | `false` |
| `--clean` | Clean segments and database on startup | `false` |

## Process Management

The system runs two ffmpeg processes per camera:
- **MP4 process**: Writes rotating segment files (`output_000.mp4`, `output_001.mp4`, ...)
- **HLS process**: Generates live HLS stream for browser playback

If ffmpeg crashes:
1. System waits 5 seconds (crash loop prevention)
2. Spawns next segment with incremented filename
3. Previous incomplete segments remain on disk
4. otslog will attempt to extract timestamps from any valid data

## Systemd Service

When installed with `--with-service`, the following is available:

```bash
sudo systemctl start otslog-web   # Start
sudo systemctl stop otslog-web    # Stop
sudo systemctl restart otslog-web # Restart
sudo systemctl status otslog-web  # Check status
journalctl -u otslog-web -f       # View live logs
```

The service automatically:
- Starts on boot
- Restarts on failure (every 5 seconds)
- Runs as the user who installed it
- Uses absolute paths for portability

## API Reference

### REST API

- `GET /api/status`: Health check — returns ffmpeg/otslog process status.
- `GET /api/list?src_path=...&otslog_path=...`: Returns a JSON list of all timestamped entries.
- `POST /api/extract`: Extracts a snapshot at a specific offset or unix timestamp.
  - Body: `{ "src_path": "...", "offset": 1234, "unix_timestamp": 1677240000 }`
- `GET /api/download?path=...`: Downloads an extracted file or its `.ots` proof.

### WebSocket

- `WS /ws/stamp`: Streams live output from `otslog stamp --follow`.
  - Expects a configuration JSON on connection: `{ "src_path": "...", "follow_interval": 5 }`

### Static & Streams

- `GET /`: Serves the main dashboard UI.
- `GET /stream/*`: Serves HLS segments and playlists with correct MIME types and CORS headers.
- `GET /vendor/hls.min.js`: Serves the vendored `hls.js` library.

## HTTPS and Production

For production use, it is recommended to use a reverse proxy like **Caddy** to handle HTTPS and provide a secure connection. Refer to the [Caddy documentation](https://caddyserver.com/docs/) for more information on setting up a reverse proxy.

## Troubleshooting

### ffmpeg fails with "Invalid argument" on tee muxer

This affects older ffmpeg versions (e.g., 7.1.3 on Raspberry Pi). The code automatically uses separate ffmpeg processes instead of the tee muxer to work around this bug.

### Camera stream not available

- Check RTSP URL and credentials
- Verify network connectivity to camera
- Check camera is actually streaming

### Service won't start

```bash
# Check systemd status
sudo systemctl status otslog-web

# View detailed logs
journalctl -u otslog-web -xe

# Verify .env exists
cat /home/cam01/otslog-web-raspberry/.env

# Check bun is installed
which bun
bun --version
```

### High CPU usage

Transcoding to H.264 uses more CPU than stream copy. For Raspberry Pi 4 with 720p video, this should be manageable. Consider reducing resolution or segment time if needed.

## Uninstall Service

To remove the systemd service but keep the application:

```bash
sudo systemctl stop otslog-web
sudo systemctl disable otslog-web
sudo rm /etc/systemd/system/otslog-web.service
sudo systemctl daemon-reload
```