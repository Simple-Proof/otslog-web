import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { parseArgs } from "node:util";

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

// Signal handlers for graceful shutdown
process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  process.exit(0);
});

// Export for Bun with WebSocket support
export default {
  fetch: app.fetch,
  websocket,
  port,
};
