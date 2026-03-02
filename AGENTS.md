# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-01
**Commit:** 2ad8c22
**Branch:** master

## OVERVIEW

Bun + Hono web server bridging ffmpeg (RTSP → MP4 + HLS), otslog (OpenTimestamps stamping), and a browser dashboard. Three managed processes: ffmpeg captures video segments, otslog stamps them against Bitcoin, web server serves HLS stream + REST API + WebSocket feed.

## STRUCTURE

```
./
├── src/
│   ├── index.ts              # Hono server, all routes, WS, boot sequence
│   ├── ffmpeg.ts             # ffmpeg process spawn/kill, arg builder
│   ├── otslog.ts             # otslog CLI wrapper: list, extract, stampFollow
│   ├── segment-watcher.ts    # fs.watch for new MP4s → auto-spawn stamp
│   ├── line-splitter.ts      # AsyncGenerator: ReadableStream → lines
│   ├── frontend.html         # Single-page dashboard (vanilla JS + hls.js)
│   ├── *.test.ts             # Colocated unit tests (bun:test)
│   └── vendor/hls.min.js     # Vendored hls.js (not npm-installed)
├── infra/main.tf             # Terraform: EC2 + EIP + Route53 + SG
├── Dockerfile                # oven/bun:1-debian + ffmpeg + otslog binary
├── docker-compose.yml        # otslog-web + Caddy reverse proxy
├── Caddyfile                 # HTTPS + WebSocket proxy for rtsp.simpleproof.xyz
└── deploy.sh                 # Terraform apply → docker build → SSH transfer → compose up
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add/modify API routes | `src/index.ts` | All routes in single file, Hono handlers |
| Change ffmpeg args | `src/ffmpeg.ts` → `buildFfmpegArgs()` | Dual output: segment + HLS |
| Change otslog invocation | `src/otslog.ts` → `buildStampArgs()` | Also `buildListArgs`, `buildExtractArgs` |
| Modify segment auto-stamp | `src/segment-watcher.ts` | `SegmentWatcher` class, fs.watch based |
| Edit dashboard UI | `src/frontend.html` | 1056-line SPA, no build step |
| Change stream parsing | `src/line-splitter.ts` | Shared by ffmpeg.ts, otslog.ts, segment-watcher.ts |
| Infrastructure/deploy | `infra/main.tf`, `deploy.sh` | AWS us-west-2, t3.small, 30GB gp3 |
| Docker config | `Dockerfile`, `docker-compose.yml` | Port 3777 internal, Caddy handles 80/443 |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `app` | Hono instance | `index.ts:85` | All HTTP routes + WebSocket |
| `export default { fetch, websocket, port }` | Bun server export | `index.ts:432` | Entry point for `bun run` |
| `startFfmpeg(opts)` | async function | `ffmpeg.ts:109` | Spawns ffmpeg, returns proc + stderr lines |
| `list(opts)` | async function | `otslog.ts:198` | Runs `otslog list`, parses TSV output |
| `extract(opts)` | async function | `otslog.ts:269` | Runs `otslog extract`, returns file paths |
| `stampFollow(opts)` | function | `otslog.ts:165` | Spawns `otslog stamp --follow`, filters dbg lines |
| `SegmentWatcher` | class | `segment-watcher.ts:40` | Watches dir, auto-spawns stamp per segment |
| `splitLines(stream)` | AsyncGenerator | `line-splitter.ts:1` | Core stream utility used by all modules |
| `broadcastLine/Status` | functions | `index.ts:55,65` | Pushes to stampBuffer + all WS clients |
| `parseListLine(line)` | function | `otslog.ts:233` | Parses `index\toffset=N\ttime=N\tdigest=X` TSV |

## CONVENTIONS

- **Runtime**: Bun — NOT Node.js. Use `Bun.spawn`, `Bun.file`, `bun:test`
- **No build step**: `tsconfig.json` has `noEmit: true`. Bun runs `.ts` directly
- **Imports**: Always use `.ts` extension in relative imports (`"./otslog.ts"` not `"./otslog"`)
- **Import types**: Use `import type { X }` for type-only imports (`verbatimModuleSyntax: true`)
- **Config pattern**: Functions take `*Opts` interface, destructure with defaults inside
- **Section dividers**: `// ---...--- // SECTION NAME // ---...---` between logical blocks
- **Exports**: Named exports everywhere. Default export only for Bun server entry
- **Naming**: camelCase functions, PascalCase classes/interfaces, UPPER_SNAKE constants
- **Interfaces**: Suffix with `Opts`, `Result`, `Entry`, `Process` by role
- **Async streams**: `AsyncGenerator<string>` via `splitLines()` for all subprocess I/O
- **Process tracking**: Module-level `let activeProc: Subprocess | null` with kill/status helpers
- **No linter/formatter**: No ESLint, Prettier, or Biome configured
- **1 production dep**: Only `hono`. Everything else is Bun built-in or vendored

## ANTI-PATTERNS (THIS PROJECT)

- **No `@ts-ignore` / `@ts-expect-error`** — zero suppressions exist, keep it that way
- **No `as any`** — strict mode with `noUncheckedIndexedAccess: true`
- **Don't npm-install hls.js** — it's vendored in `src/vendor/hls.min.js`
- **Don't add a build step** — Bun runs TypeScript directly, `noEmit: true`
- **Don't use `node:` APIs when Bun equivalents exist** — prefer `Bun.file`, `Bun.spawn`, `Bun.write`
- **Don't filter `[src/` lines in line-splitter** — filtering is caller's responsibility (otslog.ts, segment-watcher.ts)

## UNIQUE STYLES

- **Tee muxer pattern**: Single ffmpeg encode → dual output (MP4 segments + HLS). Don't split into two ffmpeg processes
- **Idle timeout**: Stamp process stops when file stops growing (ffmpeg rotated to next segment), not on explicit signal
- **Circular buffer**: `stampBuffer` (300 lines) replays history to new WS clients. Not persisted
- **Debug line filtering**: otslog Rust binary emits `[src/...] dbg!()` lines on stderr — filtered before broadcast
- **Extract path discovery**: When using `-t` (timestamp), parse stderr `dbg!()` output for created file paths via regex

## COMMANDS

```bash
# Install
bun install

# Run (requires otslog binary + RTSP_URL env)
export RTSP_URL="rtsp://admin:pass@camera:554/stream"
bun run src/index.ts --otslog-bin /path/to/otslog

# Run without ffmpeg/stamp (UI dev)
bun run src/index.ts --no-ffmpeg --no-stamp

# Test
bun test

# Docker build + deploy
./deploy.sh                          # Full: terraform → build → transfer → compose up
docker build -t otslog-web:latest .  # Local build only
```

## NOTES

- **`RTSP_URL` in env, not CLI** — keeps credentials out of `ps aux` output
- **`noUncheckedIndexedAccess`** — array indexing returns `T | undefined`; use `!` after bounds checks (e.g., `parts[0]!`)
- **Path traversal guards** — `/stream/*` blocks `..` and absolute paths; `/api/download` validates path within `segmentDir`
- **CORS `*`** — HLS endpoints use `Access-Control-Allow-Origin: *` (public stream, intentional)
- **No auth** — all endpoints public; security via Caddy (HTTPS) and network/firewall
- **Segment rotation** — ffmpeg rotates MP4 every 600s (10 min). `SegmentWatcher` waits up to 10s for file content before spawning stamp
- **WebSocket protocol** — Server sends `{ line: "..." }` or `{ status: "..." }`. Client can send `{ action: "stop" }` to kill watcher
- **Domain**: `rtsp.simpleproof.xyz` — AWS us-west-2, Caddy for HTTPS
- **Test pattern**: Colocated `*.test.ts`, use `bun:test` imports (`describe`, `test`/`it`, `expect`). Inline helpers, no shared fixtures dir
