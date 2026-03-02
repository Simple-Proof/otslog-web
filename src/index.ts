import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { parseArgs } from "node:util";
import { resolve, dirname, basename, join } from "node:path";
import { list, extract } from "./otslog.ts";
import { startFfmpeg, killFfmpegProcess, isFfmpegRunning } from "./ffmpeg.ts";
import { SegmentWatcher } from "./segment-watcher.ts";

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3777" },
    "otslog-bin": { type: "string" },
    "hls-dir": { type: "string", default: "./hls" },
    "segment-dir": { type: "string", default: "./segments" },
    "segment-time": { type: "string", default: "600" },   // 10 minutes
    "segment-prefix": { type: "string", default: "output_" },
    "follow-interval": { type: "string", default: "5" },
    "idle-timeout": { type: "string", default: "40" },    // slightly more than one segment
    "ffmpeg-bin": { type: "string", default: "ffmpeg" },
    "no-ffmpeg": { type: "boolean", default: false },
    "no-stamp": { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
  },
});

const port           = parseInt(values.port as string, 10) || 3777;
const otslogBin      = values["otslog-bin"] as string | undefined;
const hlsDir         = resolve(values["hls-dir"] as string);
const segmentDir     = resolve(values["segment-dir"] as string);
const segmentTime    = parseInt(values["segment-time"] as string, 10) || 600;
const segmentPrefix  = values["segment-prefix"] as string;
const followInterval = parseInt(values["follow-interval"] as string, 10) || 5;
const idleTimeout    = parseInt(values["idle-timeout"] as string, 10) || 40;
const ffmpegBin      = values["ffmpeg-bin"] as string;
const noFfmpeg       = values["no-ffmpeg"] as boolean;
const noStamp        = values["no-stamp"] as boolean;
const clean          = values.clean as boolean;

// RTSP_URL from environment (keeps credentials out of process list / ps aux)
const rtspUrl = process.env["RTSP_URL"];

// ---------------------------------------------------------------------------
// Stamp broadcast — lines from SegmentWatcher forwarded to all WS clients
// ---------------------------------------------------------------------------

const STAMP_BUFFER_SIZE = 300;
const stampBuffer: string[] = [];
const stampClients = new Set<WSContext>();

function broadcastLine(segment: string, line: string) {
  const text = `[${basename(segment)}] ${line}`;
  stampBuffer.push(text);
  if (stampBuffer.length > STAMP_BUFFER_SIZE) stampBuffer.shift();
  const payload = JSON.stringify({ line: text });
  for (const ws of stampClients) {
    try { ws.send(payload); } catch { stampClients.delete(ws); }
  }
}

function broadcastStatus(segment: string, status: string) {
  const text = `[${basename(segment)}] ${status}`;
  stampBuffer.push(text);
  if (stampBuffer.length > STAMP_BUFFER_SIZE) stampBuffer.shift();
  const payload = JSON.stringify({ status: text });
  for (const ws of stampClients) {
    try { ws.send(payload); } catch { stampClients.delete(ws); }
  }
}

// ---------------------------------------------------------------------------
// SegmentWatcher instance
// ---------------------------------------------------------------------------

let watcher: SegmentWatcher | null = null;

// ---------------------------------------------------------------------------
// Hono app + WebSocket
// ---------------------------------------------------------------------------

const app = new Hono();
const { upgradeWebSocket, websocket } = createBunWebSocket();

// ---------------------------------------------------------------------------
// Static routes
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const file = Bun.file("./src/frontend.html");
  return c.html(await file.text(), 200, {
    "Cache-Control": "no-store",
  });
});

app.get("/favicon.ico", (c) => c.body(null, 204));

app.get("/vendor/hls.min.js", async (c) => {
  const file = Bun.file("./src/vendor/hls.min.js");
  return c.body(await file.arrayBuffer(), {
    headers: { "Content-Type": "application/javascript" },
  });
});

// ---------------------------------------------------------------------------
// HLS stream
// ---------------------------------------------------------------------------

app.get("/stream/*", async (c) => {
  const requestPath = c.req.path.replace(/^\/stream\//, "");
  if (requestPath.includes("..") || requestPath.startsWith("/")) {
    return c.text("Forbidden", 403);
  }

  const filePath = `${hlsDir}/${requestPath}`;
  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) return c.text("Not Found", 404);

    let contentType = "application/octet-stream";
    if (requestPath.endsWith(".m3u8")) contentType = "application/vnd.apple.mpegurl";
    else if (requestPath.endsWith(".ts")) contentType = "video/mp2t";

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    };
    if (requestPath.endsWith(".m3u8")) headers["Cache-Control"] = "no-cache";

    return c.body(await file.arrayBuffer(), { headers });
  } catch (error) {
    console.error(`Error serving HLS file: ${filePath}`, error);
    return c.text("Internal Server Error", 500);
  }
});

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// GET /api/list?src_path=<segment>&otslog_path=<optional>
app.get("/api/list", async (c) => {
  const srcPath      = c.req.query("src_path");
  const queryOtslog  = c.req.query("otslog_path");

  if (!srcPath) return c.json({ error: "src_path is required" }, 400);
  if (!otslogBin) return c.json({ error: "otslog-bin not configured" }, 500);

  try {
    const entries = await list({ bin: otslogBin, srcPath, otslogPath: queryOtslog });
    return c.json({ entries });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// GET /api/segments — list all MP4 segments in segmentDir
app.get("/api/segments", async (c) => {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const files = await readdir(segmentDir).catch(() => [] as string[]);
    const segments = await Promise.all(
      files
        .filter((f) => f.startsWith(segmentPrefix) && f.endsWith(".mp4"))
        .sort()
        .map(async (f) => {
          const fullPath = join(segmentDir, f);
          const s = await stat(fullPath).catch(() => null);
          const active = watcher?.activeSegments().includes(f) ?? false;
          return {
            name: f,
            path: fullPath,
            size: s?.size ?? 0,
            mtime: s?.mtime.toISOString() ?? null,
            stamping: active,
          };
        })
    );
    return c.json({ segments });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// POST /api/extract
app.post("/api/extract", async (c) => {
  let body: {
    src_path?: string;
    otslog_path?: string;
    offset?: number;
    unix_timestamp?: number;
  };

  try { body = await c.req.json(); }
  catch { return c.json({ error: "Invalid JSON body" }, 400); }

  if (!body.src_path) return c.json({ error: "src_path is required" }, 400);
  if (!otslogBin) return c.json({ error: "otslog-bin not configured" }, 500);
  if (body.offset === undefined && body.unix_timestamp === undefined) {
    return c.json({ error: "offset or unix_timestamp is required" }, 400);
  }

  try {
    const result = await extract({
      bin: otslogBin,
      srcPath: body.src_path,
      otslogPath: body.otslog_path,
      offset: body.offset,
      unixTimestamp: body.unix_timestamp,
    });
    return c.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("already exists") || msg.includes("File exists")) {
      if (body.offset !== undefined) {
        const truncatedPath = `${body.src_path}.${body.offset}`;
        const otsPath = `${truncatedPath}.ots`;
        const truncExists = await Bun.file(truncatedPath).exists();
        const otsExists = await Bun.file(otsPath).exists();
        if (truncExists && otsExists) {
          return c.json({ truncatedPath, otsPath, alreadyExisted: true });
        }
      }
      return c.json({ error: "Output files already exist: " + msg }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

// GET /api/download
app.get("/api/download", async (c) => {
  const filePath = c.req.query("path");
  if (!filePath) return c.json({ error: "path query parameter is required" }, 400);
  if (filePath.includes("..")) return c.json({ error: "Forbidden: path contains '..'" }, 403);

  const resolvedFile = resolve(filePath);
  const allowedDir   = resolve(segmentDir);

  if (!resolvedFile.startsWith(allowedDir + "/") && resolvedFile !== allowedDir) {
    return c.json({ error: "Forbidden: path outside allowed directory" }, 403);
  }

  try {
    const file = Bun.file(resolvedFile);
    if (!await file.exists()) return c.json({ error: "File not found" }, 404);
    const fileName = basename(resolvedFile);
    return c.body(await file.arrayBuffer(), {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// GET /api/status
app.get("/api/status", (c) => {
  return c.json({
    ffmpeg: isFfmpegRunning(),
    stamping: watcher?.activeSegments() ?? [],
    clients: stampClients.size,
    segmentDir,
    hlsDir,
  });
});

// ---------------------------------------------------------------------------
// WebSocket: /ws/stamp
// ---------------------------------------------------------------------------

app.get(
  "/ws/stamp",
  upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      stampClients.add(ws);
      console.log(`[ws/stamp] client connected (${stampClients.size} total)`);

      // Send active segments status
      const active = watcher?.activeSegments() ?? [];
      ws.send(JSON.stringify({
        status: active.length > 0
          ? `stamping: ${active.join(", ")}`
          : "idle",
      }));

      // Replay recent history
      for (const line of stampBuffer) {
        ws.send(JSON.stringify({ line }));
      }
    },

    onMessage(event, ws) {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.action === "stop") {
          watcher?.stop();
          for (const ws2 of stampClients) {
            ws2.send(JSON.stringify({ status: "stopped" }));
          }
        }
      } catch {
        ws.send(JSON.stringify({ error: "Invalid JSON" }));
      }
    },

    onClose(_event, ws) {
      stampClients.delete(ws);
      console.log(`[ws/stamp] client disconnected (${stampClients.size} total)`);
    },
  }))
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully...`);
  killFfmpegProcess();
  watcher?.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------------
// Clean artifacts
// ---------------------------------------------------------------------------

async function cleanArtifacts() {
  const { rm, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  console.log("[clean] removing segments/, hls/ and otslog artifacts...");
  for (const dir of [segmentDir, hlsDir]) {
    try {
      const entries = await readdir(dir);
      await Promise.all(entries.map(e => rm(join(dir, e), { recursive: true, force: true })));
    } catch {}
  }
  console.log("[clean] done");
}

// ---------------------------------------------------------------------------
// Boot: ffmpeg
// ---------------------------------------------------------------------------

async function autoStartFfmpeg() {
  if (noFfmpeg) {
    console.log("[boot] ffmpeg auto-start disabled (--no-ffmpeg)");
    return;
  }
  if (!rtspUrl) {
    console.log("[boot] RTSP_URL not set — skipping ffmpeg.");
    return;
  }

  try {
    const { lines } = await startFfmpeg({
      rtspUrl,
      segmentDir,
      segmentTime,
      segmentPrefix,
      hlsDir,
      bin: ffmpegBin,
    });

    (async () => {
      for await (const line of lines) {
        if (line.includes("Error") || line.includes("error") || line.includes("Output #")) {
          console.log(`[ffmpeg] ${line}`);
        }
      }
      console.log("[ffmpeg] process exited");
    })();

    console.log("[boot] ffmpeg started");
  } catch (err) {
    console.error("[boot] failed to start ffmpeg:", err);
  }
}

// ---------------------------------------------------------------------------
// Boot: SegmentWatcher
// ---------------------------------------------------------------------------

function autoStartWatcher() {
  if (noStamp) {
    console.log("[boot] otslog stamp auto-start disabled (--no-stamp)");
    return;
  }
  if (!otslogBin) {
    console.log("[boot] --otslog-bin not set — skipping segment watcher.");
    return;
  }

  watcher = new SegmentWatcher({
    segmentDir,
    segmentPrefix,
    otslogBin,
    followInterval,
    idleTimeout,
    onLine: (segment, line) => {
      console.log(`[otslog:${basename(segment)}] ${line}`);
      broadcastLine(segment, line);
    },
    onStatus: (segment, status, detail) => {
      const msg = detail ? `${status}: ${detail}` : status;
      console.log(`[otslog:${basename(segment)}] ${msg}`);
      broadcastStatus(segment, msg);
    },
  });

  watcher.start();
  console.log(`[boot] segment watcher started (${segmentDir}/${segmentPrefix}*.mp4, follow=${followInterval}s, idle-timeout=${idleTimeout}s)`);
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

if (clean) await cleanArtifacts();
await autoStartFfmpeg();
autoStartWatcher();

// ---------------------------------------------------------------------------
// Export for Bun
// ---------------------------------------------------------------------------

console.log(`[boot] otslog-web listening on http://localhost:${port}`);

export default {
  fetch: app.fetch,
  websocket,
  port,
};
