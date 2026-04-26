#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/otslog-web.pid"
LOG_FILE="$SCRIPT_DIR/otslog-web.log"
ENV_FILE="$SCRIPT_DIR/.env"

start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "[start] otslog-web already running (PID $(cat "$PID_FILE"))"
        return 0
    fi

    echo "[start] Starting otslog-web..."

    if [ -f "$ENV_FILE" ]; then
        echo "[start] Loading environment from $ENV_FILE"
        set -a
        source "$ENV_FILE"
        set +a
    else
        echo "[start] WARNING: .env not found at $ENV_FILE"
    fi

    cd "$SCRIPT_DIR"

    local bun_path
    if command -v bun &>/dev/null; then
        bun_path="bun"
    elif [ -x "$HOME/.bun/bin/bun" ]; then
        bun_path="$HOME/.bun/bin/bun"
    else
        echo "[start] ERROR: bun not found in PATH and not at \$HOME/.bun/bin/bun"
        return 1
    fi

    "$bun_path" run src/index.ts \
        --otslog-bin "$SCRIPT_DIR/otslog" \
        >> "$LOG_FILE" 2>&1 &
    local pid=$!

    echo $pid > "$PID_FILE"
    echo "[start] otslog-web started (PID $pid)"
    echo "[start] Logs: $LOG_FILE"
    echo "[start] PID file: $PID_FILE"
}

stop() {
    if [ ! -f "$PID_FILE" ]; then
        echo "[stop] PID file not found. Is otslog-web running?"
        return 1
    fi

    local pid=$(cat "$PID_FILE")
    if ! kill -0 "$pid" 2>/dev/null; then
        echo "[stop] Process $pid not running. Cleaning up PID file."
        rm -f "$PID_FILE"
        return 0
    fi

    echo "[stop] Stopping otslog-web (PID $pid)..."
    kill "$pid" 2>/dev/null || true

    local count=0
    while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        echo "[stop] Force killing..."
        kill -9 "$pid" 2>/dev/null || true
    fi

    for child_ffmpeg in $(pgrep -P "$pid" 2>/dev/null); do
        echo "[stop] Killing orphaned ffmpeg child (PID $child_ffmpeg)..."
        kill "$child_ffmpeg" 2>/dev/null || true
        sleep 1
        kill -9 "$child_ffmpeg" 2>/dev/null || true
    done

    for child_ffmpeg in $(pgrep -f "ffmpeg.*rtsp" 2>/dev/null); do
        if [ "$child_ffmpeg" != "$pid" ]; then
            echo "[stop] Killing orphaned ffmpeg (PID $child_ffmpeg)..."
            kill "$child_ffmpeg" 2>/dev/null || true
            sleep 1
            kill -9 "$child_ffmpeg" 2>/dev/null || true
        fi
    done

    rm -f "$PID_FILE"
    echo "[stop] otslog-web stopped"
}

status() {
    if [ ! -f "$PID_FILE" ]; then
        echo "[status] otslog-web is not running (no PID file)"
        return 1
    fi

    local pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
        echo "[status] otslog-web is running (PID $pid)"
        return 0
    else
        echo "[status] PID file exists but process is not running"
        rm -f "$PID_FILE"
        return 1
    fi
}

restart() {
    stop
    sleep 1
    start
}

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    status)
        status
        ;;
    restart)
        restart
        ;;
    *)
        echo "Usage: $0 {start|stop|status|restart}"
        exit 1
        ;;
esac