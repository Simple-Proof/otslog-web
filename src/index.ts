import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { parseArgs } from "node:util";
import { resolve, dirname, basename } from "node:path";
import { list, extract, stampFollow, killStampProcess } from "./otslog.ts";

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    port: {
      type: "string",
      default: "3777",
    },
    "otslog-bin": {
      type: "string",
    },
    "hls-dir": {
      type: "string",
    },
    "src-path": {
      type: "string",
    },
    "otslog-path": {
      type: "string",
    },
  },
});

const port = parseInt(values.port as string, 10) || 3777;
const otslogBin = values["otslog-bin"] as string | undefined;
const hlsDir = values["hls-dir"] as string | undefined;
const srcPath = values["src-path"] as string | undefined;
const otslogPath = values["otslog-path"] as string | undefined;

// Initialize Hono app
const app = new Hono();

// Initialize WebSocket support
const { upgradeWebSocket, websocket } = createBunWebSocket({ fetch: Bun.fetch });

// Basic route for health check
app.get("/", (c) => {
  return c.text("otslog-web server running");
});

// Serve vendored hls.js
app.get("/vendor/hls.min.js", async (c) => {
  const file = Bun.file("./src/vendor/hls.min.js");
  return c.body(await file.arrayBuffer(), {
    headers: {
      "Content-Type": "application/javascript",
    },
  });
});

// Serve HLS stream files with proper MIME types and CORS
app.get("/stream/*", async (c) => {
  if (!hlsDir) {
    return c.text("HLS directory not configured", 400);
  }

  // Get the requested path from the wildcard
  const requestPath = c.req.path.replace(/^\/stream\//, "");

  // Prevent directory traversal attacks
  if (requestPath.includes("..") || requestPath.startsWith("/")) {
    return c.text("Forbidden", 403);
  }

  // Construct the full file path
  const filePath = `${hlsDir}/${requestPath}`;

  try {
    // Check if file exists
    const file = Bun.file(filePath);
    const exists = await file.exists();

    if (!exists) {
      return c.text("Not Found", 404);
    }

    // Determine MIME type based on file extension
    let contentType = "application/octet-stream";
    if (requestPath.endsWith(".m3u8")) {
      contentType = "application/vnd.apple.mpegurl";
    } else if (requestPath.endsWith(".ts")) {
      contentType = "video/mp2t";
    }

    // Set headers
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    };

    // Add Cache-Control for m3u8 files
    if (requestPath.endsWith(".m3u8")) {
      headers["Cache-Control"] = "no-cache";
    }

    return c.body(await file.arrayBuffer(), { headers });
  } catch (error) {
    console.error(`Error serving HLS file: ${filePath}`, error);
    return c.text("Internal Server Error", 500);
  }
});

// ---------------------------------------------------------------------------
// REST API Routes
// ---------------------------------------------------------------------------

// GET /api/list - List otslog entries
app.get("/api/list", async (c) => {
  const querySrcPath = c.req.query("src_path") || srcPath;
  const queryOtslogPath = c.req.query("otslog_path") || otslogPath;

  if (!querySrcPath) {
    return c.json({ error: "src_path is required (query param or --src-path)" }, 400);
  }
  if (!otslogBin) {
    return c.json({ error: "otslog-bin not configured" }, 500);
  }

  try {
    const entries = await list({
      bin: otslogBin,
      srcPath: querySrcPath,
      otslogPath: queryOtslogPath,
    });
    return c.json({ entries });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return c.json({ error: msg }, 500);
  }
});

// POST /api/extract - Extract a timestamped snapshot
app.post("/api/extract", async (c) => {
  let body: {
    src_path?: string;
    otslog_path?: string;
    offset?: number;
    unix_timestamp?: number;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const extractSrcPath = body.src_path || srcPath;
  const extractOtslogPath = body.otslog_path || otslogPath;

  if (!extractSrcPath) {
    return c.json({ error: "src_path is required (body or --src-path)" }, 400);
  }
  if (!otslogBin) {
    return c.json({ error: "otslog-bin not configured" }, 500);
  }
  if (body.offset === undefined && body.unix_timestamp === undefined) {
    return c.json({ error: "offset or unix_timestamp is required" }, 400);
  }

  try {
    const result = await extract({
      bin: otslogBin,
      srcPath: extractSrcPath,
      otslogPath: extractOtslogPath,
      offset: body.offset,
      unixTimestamp: body.unix_timestamp,
    });
    return c.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // otslog extract uses create_new(true) — files already exist is a common error
    if (msg.includes("already exists") || msg.includes("File exists")) {
      // Try to return existing paths if offset is known
      if (body.offset !== undefined) {
        const truncatedPath = `${extractSrcPath}.${body.offset}`;
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

// GET /api/download - Download a file with Content-Disposition: attachment
app.get("/api/download", async (c) => {
  const filePath = c.req.query("path");

  if (!filePath) {
    return c.json({ error: "path query parameter is required" }, 400);
  }

  // Security: reject directory traversal
  if (filePath.includes("..")) {
    return c.json({ error: "Forbidden: path contains '..'" }, 403);
  }

  // Security: restrict downloads to the src_path directory
  if (!srcPath) {
    return c.json({ error: "src-path not configured, cannot validate download" }, 500);
  }

  const resolvedFile = resolve(filePath);
  const allowedDir = resolve(dirname(srcPath));

  if (!resolvedFile.startsWith(allowedDir + "/") && resolvedFile !== allowedDir) {
    return c.json({ error: "Forbidden: path outside allowed directory" }, 403);
  }

  try {
    const file = Bun.file(resolvedFile);
    const exists = await file.exists();

    if (!exists) {
      return c.json({ error: "File not found" }, 404);
    }

    const fileName = basename(resolvedFile);
    return c.body(await file.arrayBuffer(), {
      headers: {
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/octet-stream",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return c.json({ error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// WebSocket: /ws/stamp — stream stamp --follow output
// ---------------------------------------------------------------------------

app.get(
  "/ws/stamp",
  upgradeWebSocket((c) => {
    let abortController: AbortController | null = null;

    return {
      onOpen(_event, ws) {
        // Wait for client to send config before starting
        console.log("[ws/stamp] client connected, awaiting config");
      },

      async onMessage(event, ws) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          ws.send(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        // Handle stop action
        if (msg.action === "stop") {
          if (abortController) {
            abortController.abort();
            abortController = null;
          }
          killStampProcess();
          ws.send(JSON.stringify({ status: "stopped" }));
          return;
        }

        // Treat as config message — start stamp follow
        const cfgSrcPath = (msg.src_path as string) || srcPath;
        const cfgOtslogPath = (msg.otslog_path as string) || otslogPath;
        const followInterval = (msg.follow_interval as number) ?? 10;
        const idleTimeout = msg.idle_timeout as number | undefined;
        const aggregators = msg.aggregators as string[] | undefined;

        if (!cfgSrcPath) {
          ws.send(JSON.stringify({ error: "src_path is required" }));
          return;
        }
        if (!otslogBin) {
          ws.send(JSON.stringify({ error: "otslog-bin not configured" }));
          return;
        }

        // Kill any previous stamp process before starting a new one
        if (abortController) {
          abortController.abort();
        }
        killStampProcess();

        abortController = new AbortController();
        const { signal } = abortController;

        try {
          const { lines } = stampFollow({
            bin: otslogBin,
            srcPath: cfgSrcPath,
            otslogPath: cfgOtslogPath,
            followInterval,
            idleTimeout,
            aggregators,
          });

          ws.send(JSON.stringify({ status: "started" }));

          for await (const line of lines) {
            if (signal.aborted) break;
            ws.send(JSON.stringify({ line }));
          }

          if (!signal.aborted) {
            ws.send(JSON.stringify({ status: "done" }));
          }
        } catch (err) {
          if (!signal.aborted) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ error: errMsg }));
          }
        }
      },

      onClose() {
        console.log("[ws/stamp] client disconnected");
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        killStampProcess();
      },
    };
  })
);

// Signal handlers for graceful shutdown
process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  killStampProcess();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  killStampProcess();
  process.exit(0);
});

// Export for Bun with WebSocket support
export default {
  fetch: app.fetch,
  websocket,
  port,
};
