FROM oven/bun:1-debian AS base

# Install ffmpeg + OpenSSL 3 (for otslog)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libssl3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy otslog binary
COPY otslog /usr/local/bin/otslog
RUN chmod +x /usr/local/bin/otslog

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Create runtime directories
RUN mkdir -p /data/segments /data/hls

EXPOSE 3777

ENV SEGMENT_DIR=/data/segments
ENV HLS_DIR=/data/hls

CMD ["bun", "run", "src/index.ts", \
     "--otslog-bin", "/usr/local/bin/otslog", \
     "--segment-dir", "/data/segments", \
     "--hls-dir", "/data/hls", \
     "--segment-time", "600", \
     "--port", "3777"]
