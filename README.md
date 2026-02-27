# otslog-web

A web interface and API for `otslog`, providing live video streaming alongside real-time OpenTimestamps activity. It allows users to monitor a growing log file, view its live HLS video representation, and extract timestamped snapshots with their corresponding proofs.

## Overview

`otslog-web` acts as a bridge between the `otslog` CLI and a web browser. It handles:
- Spawning and managing `ffmpeg` (RTSP → MP4 + HLS via tee muxer, single encode).
- Auto-starting `otslog stamp --follow` on the growing MP4 file.
- Serving HLS video segments for live playback.
- Streaming real-time `otslog stamp --follow` output via WebSockets.
- Providing a REST API for listing and extracting snapshots.
- A single-page dashboard for monitoring and interaction.

## Prerequisites

- **Bun**: Fast JavaScript runtime and package manager.
- **otslog**: The Rust-based CLI tool for OpenTimestamps logging.
- **ffmpeg**: Used to generate HLS segments and the source MP4 file.

## Quick Start

1.  **Install dependencies**:
    ```bash
    bun install
    ```

2.  **Set the RTSP URL** (keeps credentials out of process list):
    ```bash
    export RTSP_URL="rtsp://admin:password@your-camera:554/stream"
    ```

3.  **Start the server** (ffmpeg + otslog start automatically):
    ```bash
    bun run src/index.ts --otslog-bin /path/to/otslog
    ```

4.  **Open the dashboard**:
    Navigate to `http://localhost:3777` in your browser.

That's it. The server will:
- Spawn ffmpeg with the tee muxer (RTSP → `output.mp4` + `hls/live.m3u8`).
- After 2 seconds, spawn `otslog stamp output.mp4 --follow 5`.
- Serve the HLS stream and dashboard UI.

## Configuration

### CLI Arguments

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--port` | Port to run the server on | `3777` |
| `--otslog-bin` | Path to the `otslog` binary | *(none — required for stamping)* |
| `--hls-dir` | Directory for HLS segments | `./hls` |
| `--src-path` | Path to the growing MP4 file | `output.mp4` |
| `--otslog-path` | Explicit `.otslog` metadata path | *(auto-derived)* |
| `--follow-interval` | Stamp follow interval in seconds | `5` |
| `--ffmpeg-bin` | Path to the `ffmpeg` binary | `ffmpeg` |
| `--no-ffmpeg` | Disable auto-starting ffmpeg | `false` |
| `--no-stamp` | Disable auto-starting otslog stamp | `false` |

### Environment Variables

| Variable | Description |
| :--- | :--- |
| `RTSP_URL` | Full RTSP URL with credentials. **Required** for ffmpeg auto-start. |

### Running ffmpeg externally

If you prefer to run ffmpeg yourself (or it's already running), use `--no-ffmpeg`:

```bash
# Start ffmpeg manually with tee muxer (single encode, dual output)
ffmpeg -rtsp_transport tcp -i "$RTSP_URL" \
  -c:v libx264 -preset ultrafast -tune zerolatency -an \
  -f tee "[f=mp4:movflags=frag_keyframe+empty_moov+default_base_moof]output.mp4|[f=hls:hls_time=4:hls_list_size=10:hls_flags=delete_segments]hls/live.m3u8"

# Then start otslog-web without ffmpeg
bun run src/index.ts --otslog-bin /path/to/otslog --no-ffmpeg
```

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

## Architecture

```text
+----------------+      +----------------+      +----------------+
|     ffmpeg     |----->|   output.mp4   |<-----|     otslog     |
| (tee muxer)   |      | (Source File)  |      | (stamp --follow)|
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

All three processes (ffmpeg, otslog, web server) are managed by `otslog-web` and shut down gracefully on SIGINT/SIGTERM.

## HTTPS and Production

For production use, it is recommended to use a reverse proxy like **Caddy** to handle HTTPS and provide a secure connection. Refer to the [Caddy documentation](https://caddyserver.com/docs/) for more information on setting up a reverse proxy.
