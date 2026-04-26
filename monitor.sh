#!/usr/bin/env bash
# Auto-monitor for otslog-web: detects FIRST 403 and restarts immediately.
# The camera RTSP server permanently locks out once sessions accumulate;
# restarting after the first 403 prevents the cascade.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/otslog-web.log"
START_SCRIPT="$SCRIPT_DIR/start.sh"
CHECK_INTERVAL=10
LAST_CHECKED_LINE=0
LAST_RESTART_LINE=0
MIN_RESTART_INTERVAL=300  # Minimum seconds between restarts (5 min)

echo "[monitor] watching $LOG_FILE every ${CHECK_INTERVAL}s"

get_total_lines() {
    wc -l < "$LOG_FILE" 2>/dev/null || echo 0
}

get_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

check_for_errors() {
    local new_lines
    new_lines=$(( $(get_total_lines) - LAST_CHECKED_LINE ))

    if [ "$new_lines" -le 0 ]; then
        return 0
    fi

    # Check for 403 Forbidden — restart on FIRST occurrence
    local errors_403
    errors_403=$(tail -n "$new_lines" "$LOG_FILE" | grep -c "403 Forbidden" || true)

    if [ "$errors_403" -gt 0 ]; then
        local current_line
        current_line=$(get_total_lines)

        # Prevent restart loops: enforce minimum interval
        local now
        now=$(date +%s)
        local elapsed=$((now - LAST_RESTART_LINE))
        if [ "$LAST_RESTART_LINE" -gt 0 ] && [ "$elapsed" -lt "$MIN_RESTART_INTERVAL" ]; then
            echo "[$(get_timestamp)] [monitor] $errors_403 x 403 detected but skipping restart (${elapsed}s since last, min ${MIN_RESTART_INTERVAL}s)"
            LAST_CHECKED_LINE=$current_line
            return 0
        fi

        echo "[$(get_timestamp)] [monitor] 403 detected ($errors_403 occurrences) — restarting otslog-web..."
        "$START_SCRIPT" stop 2>/dev/null || true
        # Wait for camera to clean up stale RTSP sessions
        echo "[$(get_timestamp)] [monitor] waiting 30s for camera session cleanup..."
        sleep 30
        "$START_SCRIPT" start
        LAST_RESTART_LINE=$(date +%s)
        echo "[$(get_timestamp)] [monitor] restart complete"
    fi

    LAST_CHECKED_LINE=$(get_total_lines)
}

# Initialize
LAST_CHECKED_LINE=$(get_total_lines)
LAST_RESTART_LINE=0
echo "[monitor] starting at line $LAST_CHECKED_LINE ($(get_timestamp))"

while true; do
    check_for_errors
    sleep "$CHECK_INTERVAL"
done
