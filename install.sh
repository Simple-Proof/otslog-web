#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════════════════════
# otslog-web install script
# Detects and installs ffmpeg and bun if missing
# Makes otslog executable
# ═══════════════════════════════════════════════════════════════════════════════

echo "[install] Starting..."

# ── Detect package manager ────────────────────────────────────────────────────
if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt-get"
elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
elif command -v apk &>/dev/null; then
    PKG_MANAGER="apk"
elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
else
    echo "[install] ERROR: No supported package manager found (apt, yum, dnf, apk, pacman)"
    exit 1
fi
echo "[install] Detected package manager: $PKG_MANAGER"

# ── Install ffmpeg ───────────────────────────────────────────────────────────
if command -v ffmpeg &>/dev/null; then
    echo "[install] ffmpeg found: $(ffmpeg -version 2>&1 | head -1)"
else
    echo "[install] ffmpeg not found. Installing..."
    if [ "$PKG_MANAGER" = "apt-get" ]; then
        sudo apt-get update -qq
        sudo apt-get install -y -qq ffmpeg
    elif [ "$PKG_MANAGER" = "yum" ] || [ "$PKG_MANAGER" = "dnf" ]; then
        sudo dnf install -y ffmpeg
    elif [ "$PKG_MANAGER" = "apk" ]; then
        sudo apk add ffmpeg
    elif [ "$PKG_MANAGER" = "pacman" ]; then
        sudo pacman -Sy --noconfirm ffmpeg
    fi
    echo "[install] ffmpeg installed: $(ffmpeg -version 2>&1 | head -1)"
fi

# ── Install bun ───────────────────────────────────────────────────────────────
if command -v bun &>/dev/null; then
    echo "[install] bun found: $(bun --version)"
else
    echo "[install] bun not found. Installing..."

    # Detect architecture
    ARCH=$(uname -m)
    case "$ARCH" in
        aarch64|arm64)
            BUN_ARCH="aarch64-linux-gnu"
            ;;
        x86_64)
            BUN_ARCH="x86_64-linux-gnu"
            ;;
        armv7l|armhf)
            BUN_ARCH="armv7l-linux-gnueabihf"
            ;;
        *)
            echo "[install] ERROR: Unsupported architecture: $ARCH"
            exit 1
            ;;
    esac
    echo "[install] Detected architecture: $BUN_ARCH"

    # Download and install bun
    BUN_INSTALL_DIR=$(mktemp -d)
    curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-${BUN_ARCH}.zip" -o "${BUN_INSTALL_DIR}/bun.zip"
    unzip -q "${BUN_INSTALL_DIR}/bun.zip" -d "${BUN_INSTALL_DIR}"
    sudo mv "${BUN_INSTALL_DIR}/bun-linux-${BUN_ARCH}/bun /usr/local/bin/bun"
    sudo chmod +x /usr/local/bin/bun
    rm -rf "$BUN_INSTALL_DIR"

    echo "[install] bun installed: $(bun --version)"
fi

# ── Make otslog executable ───────────────────────────────────────────────────
OTSLOG_PATH="./otslog"
if [ -f "$OTSLOG_PATH" ]; then
    chmod +x "$OTSLOG_PATH"
    echo "[install] otslog made executable: $OTSLOG_PATH"
else
    echo "[install] WARNING: otslog not found at $OTSLOG_PATH (skipping)"
fi

# ── Final check ───────────────────────────────────────────────────────────────
echo ""
echo "[install] Final verification:"
echo "  ffmpeg: $(command -v ffmpeg && ffmpeg -version 2>&1 | head -1 || echo 'NOT FOUND')"
echo "  bun:    $(command -v bun && bun --version || echo 'NOT FOUND')"
echo "  otslog: $(ls -la "$OTSLOG_PATH" 2>/dev/null | awk '{print $1, $9}' || echo 'NOT FOUND')"
echo ""
echo "[install] Done. Run 'bun run src/index.ts --otslog-bin ./otslog' to start."