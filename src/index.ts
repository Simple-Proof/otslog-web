import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { parseArgs } from "node:util";
import { resolve, dirname, basename, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { list, extract } from "./otslog.ts";
import { startFfmpeg, isFfmpegRunning } from "./ffmpeg.ts";
import type { FfmpegProcess } from "./ffmpeg.ts";
import { SegmentWatcher } from "./segment-watcher.ts";
import { saveStamp, getAllStamps, getStampsBySegment, saveSegment, getSegments, clearDb, getStampCounts, saveExportJob, getExportJob, getRecentExportJobs, deleteOldExportJobs, deleteSegmentData, type ExportJobRecord } from "./db.ts";

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3777" },
    "otslog-bin": { type: "string" },
    "segment-dir": { type: "string", default: "./segments" },
    "segment-time": { type: "string", default: "600" },   // 10 minutes
    "segment-prefix": { type: "string", default: "output_" },
    "follow-interval": { type: "string", default: "1" },
    "idle-timeout": { type: "string", default: "40" },    // slightly more than one segment
    "ffmpeg-bin": { type: "string", default: "ffmpeg" },
    "no-ffmpeg": { type: "boolean", default: false },
    "no-stamp": { type: "boolean", default: false },
    clean: { type: "boolean", default: false },
  },
});

const port           = parseInt(values.port as string, 10) || 3777;
const otslogBin      = values["otslog-bin"] as string | undefined;
const segmentDir     = resolve(values["segment-dir"] as string);
const hlsDir         = join(segmentDir, "hls");
const segmentTime    = parseInt(values["segment-time"] as string, 10) || 600;
const segmentPrefix  = values["segment-prefix"] as string;
const followInterval = parseInt(values["follow-interval"] as string, 10) || 1;
const idleTimeout    = parseInt(values["idle-timeout"] as string, 10) || 40;
const ffmpegBin      = values["ffmpeg-bin"] as string;
const noFfmpeg       = values["no-ffmpeg"] as boolean;
const noStamp        = values["no-stamp"] as boolean;
const clean          = values.clean as boolean;

// RTSP_URL from environment (keeps credentials out of process list / ps aux)
const rtspUrl = process.env["RTSP_URL"];

interface CameraConfig {
  id: string;
  name: string;
  rtspUrl: string;
  hlsUrl: string;
  segmentPrefix: string;
  localHls?: boolean;
}

function cameraEnvPrefix(cameraId: string): string {
  return cameraId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
}

function parseCameraConfigs(): CameraConfig[] {
  const camerasEnv = process.env["CAMERAS"];
  if (camerasEnv) {
    const ids = camerasEnv.split(",").map((s) => s.trim()).filter(Boolean);
    const cameras: CameraConfig[] = [];

    for (const id of ids) {
      const key = cameraEnvPrefix(id);
      const camRtsp = process.env[`${key}_RTSP_URL`];
      const camHls = process.env[`${key}_HLS_URL`];
      if (!camRtsp) {
        console.warn(`[boot] skipping camera '${id}': missing ${key}_RTSP_URL`);
        continue;
      }

      cameras.push({
        id,
        name: process.env[`${key}_NAME`] ?? id.toUpperCase(),
        rtspUrl: camRtsp,
        hlsUrl: camHls ?? `/stream/${id}/live.m3u8`,
        localHls: !camHls,
        segmentPrefix: `${id}_output_`,
      });
    }

    if (cameras.length > 0) return cameras;
  }

  const envHlsUrl = process.env["HLS_URL"];
  if (!rtspUrl) return [];
  return [{
    id: "default",
    name: process.env["CAMERA_NAME"] ?? "Default",
    rtspUrl,
    hlsUrl: envHlsUrl ?? `/stream/default/live.m3u8`,
    localHls: !envHlsUrl,
    segmentPrefix,
  }];
}

const cameras = parseCameraConfigs();
const cameraById = new Map(cameras.map((c) => [c.id, c]));

function findCameraBySegmentName(name: string): CameraConfig | undefined {
  return cameras.find((c) => name.startsWith(c.segmentPrefix));
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const textEncoder = new TextEncoder();
const SEGMENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$/;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const EXPORT_JOB_TTL_MS = 60 * 60 * 1000;
const EXPORT_URL_TTL_SECONDS = 60 * 30;
const exportDir = join(segmentDir, ".exports");
const segmentRetentionHours = Math.max(1, parseInt(process.env["SEGMENT_RETENTION_HOURS"] ?? "24", 10) || 24);
const segmentCleanupIntervalSeconds = Math.max(60, parseInt(process.env["SEGMENT_CLEANUP_INTERVAL_SECONDS"] ?? "900", 10) || 900);
const stampTimeoutSeconds = Math.max(5, parseInt(process.env["STAMP_TIMEOUT_SECONDS"] ?? "30", 10) || 30);
const stampMinAttestations = Math.max(1, parseInt(process.env["STAMP_MIN_ATTESTATIONS"] ?? "1", 10) || 1);
const stampAggregators = (process.env["STAMP_AGGREGATORS"] ?? "https://alice.btc.calendar.opentimestamps.org/digest,https://bob.btc.calendar.opentimestamps.org/digest")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

interface RetentionStats {
  enabled: boolean;
  retentionHours: number;
  intervalSeconds: number;
  lastRunAt: number | null;
  lastError: string | null;
  lastPrunedSegments: number;
  lastOrphanDbDeletes: number;
  totalPrunedSegments: number;
  totalOrphanDbDeletes: number;
}

const retentionStats: RetentionStats = {
  enabled: false,
  retentionHours: segmentRetentionHours,
  intervalSeconds: segmentCleanupIntervalSeconds,
  lastRunAt: null,
  lastError: null,
  lastPrunedSegments: 0,
  lastOrphanDbDeletes: 0,
  totalPrunedSegments: 0,
  totalOrphanDbDeletes: 0,
};

type ExportJobStatus = "queued" | "running" | "uploading" | "done" | "failed" | "cancelled";

interface ExportJob {
  id: string;
  segmentName: string;
  offset: number;
  status: ExportJobStatus;
  progress: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  zipName: string;
  zipPath: string | null;
  s3Key: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: number | null;
}

const exportJobs = new Map<string, ExportJob>();
const exportAbortControllers = new Map<string, AbortController>();

const exportBucket = process.env["S3_EXPORT_BUCKET"]?.trim();
const exportPrefix = process.env["S3_EXPORT_PREFIX"]?.trim() || "exports";
const awsRegion = process.env["AWS_REGION"]?.trim() || process.env["AWS_DEFAULT_REGION"]?.trim() || "us-east-2";
const s3Client = exportBucket ? new S3Client({ region: awsRegion }) : null;

function toExportJobRecord(job: ExportJob): ExportJobRecord {
  return {
    id: job.id,
    segment_name: job.segmentName,
    offset: job.offset,
    status: job.status,
    progress: job.progress,
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt,
    zip_name: job.zipName,
    zip_path: job.zipPath,
    s3_key: job.s3Key,
    download_url: job.downloadUrl,
    download_url_expires_at: job.downloadUrlExpiresAt,
  };
}

function fromExportJobRecord(record: ExportJobRecord): ExportJob {
  return {
    id: record.id,
    segmentName: record.segment_name,
    offset: record.offset,
    status: record.status as ExportJobStatus,
    progress: record.progress,
    error: record.error,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    completedAt: record.completed_at,
    zipName: record.zip_name,
    zipPath: record.zip_path,
    s3Key: record.s3_key,
    downloadUrl: record.download_url,
    downloadUrlExpiresAt: record.download_url_expires_at,
  };
}

function persistExportJob(job: ExportJob): void {
  saveExportJob(toExportJobRecord(job));
}

function isPrimarySegmentName(filename: string): boolean {
  if (!filename.endsWith(".mp4")) return false;
  if (/\[\d+\]\.mp4$/i.test(filename)) return false;
  if (cameras.length === 0) return filename.startsWith(segmentPrefix);
  return cameras.some((camera) => filename.startsWith(camera.segmentPrefix));
}

function extractOutputCandidates(srcPath: string, offset: number): { truncatedPath: string; otsPath: string }[] {
  const ext = extname(srcPath);
  const stem = ext ? srcPath.slice(0, -ext.length) : srcPath;
  const bracket = `${stem}[${offset}]${ext}`;
  const legacy = `${srcPath}.${offset}`;
  return [
    { truncatedPath: bracket, otsPath: `${bracket}.ots` },
    { truncatedPath: legacy, otsPath: `${legacy}.ots` },
  ];
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const crc32Table = buildCrc32Table();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c = crc32Table[(c ^ byte) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDay = ((year - 1980) << 9) | (month << 5) | day;

  return { time: dosTime, day: dosDay };
}

function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function buildStoredZip(entries: ZipEntry[]): Uint8Array {
  const now = new Date();
  const { time: dosTime, day: dosDay } = toDosDateTime(now);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];

  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const nameBytes = textEncoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = new Uint8Array(30);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDay, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);

    localParts.push(localHeader, nameBytes, entry.data);

    const centralHeader = new Uint8Array(46);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDay, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, localOffset, true);

    centralParts.push(centralHeader, nameBytes);
    centralSize += centralHeader.length + nameBytes.length;

    localOffset += localHeader.length + nameBytes.length + entry.data.length;
  }

  const endRecord = new Uint8Array(22);
  const ev = new DataView(endRecord.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  const allParts = [...localParts, ...centralParts, endRecord];
  const totalLength = localOffset + centralSize + endRecord.length;
  return concatBytes(allParts, totalLength);
}

function sanitizeZipName(segmentName: string, offset: number): string {
  return `${segmentName}.${offset}.zip`.replace(/[\r\n"]/g, "_");
}

function pruneOldExportJobs(now: number): void {
  const cutoff = now - EXPORT_JOB_TTL_MS;
  deleteOldExportJobs(cutoff);

  for (const [id, job] of exportJobs.entries()) {
    if ((job.status === "done" || job.status === "failed" || job.status === "cancelled") && now - job.updatedAt > EXPORT_JOB_TTL_MS) {
      if (job.zipPath) {
        const zipPath = job.zipPath;
        void Bun.file(zipPath).exists().then((exists) => {
          if (exists) return Bun.file(zipPath).delete();
        }).catch(() => {});
      }
      exportAbortControllers.delete(id);
      exportJobs.delete(id);
    }
  }
}

function ensureSegmentPath(segmentName: string): string {
  const segmentCamera = findCameraBySegmentName(segmentName);
  if (!segmentCamera || !SEGMENT_NAME_RE.test(segmentName)) {
    throw new Error("Invalid segment_name");
  }
  if (segmentName.includes("/") || segmentName.includes("\\") || segmentName.includes("..")) {
    throw new Error("Invalid segment_name");
  }

  const srcPath = join(segmentDir, segmentName);
  const resolvedSrcPath = resolve(srcPath);
  if (!resolvedSrcPath.startsWith(segmentDir + "/")) {
    throw new Error("Forbidden: path outside allowed directory");
  }
  return resolvedSrcPath;
}

async function resolveExtractOutputs(resolvedSrcPath: string, offset: number): Promise<{ truncatedResolved: string; otsResolved: string }> {
  if (!otslogBin) {
    throw new Error("otslog-bin not configured");
  }

  let extractResult: { truncatedPath: string; otsPath: string };
  try {
    extractResult = await extract({
      bin: otslogBin,
      srcPath: resolvedSrcPath,
      offset,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("already exists") || msg.includes("File exists")) {
      const candidates = extractOutputCandidates(resolvedSrcPath, offset);
      let found: { truncatedPath: string; otsPath: string } | null = null;
      for (const candidate of candidates) {
        const exists = await Bun.file(candidate.truncatedPath).exists() && await Bun.file(candidate.otsPath).exists();
        if (exists) {
          found = candidate;
          break;
        }
      }
      if (!found) {
        throw new Error("Extract output files already exist but could not be resolved");
      }
      extractResult = found;
    } else {
      throw error;
    }
  }

  const truncatedResolved = resolve(extractResult.truncatedPath);
  const otsResolved = resolve(extractResult.otsPath);
  if (!truncatedResolved.startsWith(segmentDir + "/") || !otsResolved.startsWith(segmentDir + "/")) {
    throw new Error("Forbidden: output outside allowed directory");
  }

  const truncatedFile = Bun.file(truncatedResolved);
  const otsFile = Bun.file(otsResolved);
  if (!await truncatedFile.exists() || !await otsFile.exists()) {
    throw new Error("Extract output files not found");
  }

  return { truncatedResolved, otsResolved };
}

async function buildZipBytesFromOutputs(truncatedResolved: string, otsResolved: string): Promise<Uint8Array> {
  const truncatedData = new Uint8Array(await Bun.file(truncatedResolved).arrayBuffer());
  const otsData = new Uint8Array(await Bun.file(otsResolved).arrayBuffer());

  const combinedSize = truncatedData.byteLength + otsData.byteLength;
  if (combinedSize > MAX_ZIP_BYTES) {
    throw new Error(`ZIP exceeds max size (${MAX_ZIP_BYTES} bytes)`);
  }

  return buildStoredZip([
    { name: basename(truncatedResolved), data: truncatedData },
    { name: basename(otsResolved), data: otsData },
  ]);
}

async function ensureJobDownloadUrl(job: ExportJob): Promise<void> {
  if (job.status !== "done") return;
  const now = Date.now();
  if (job.downloadUrl && job.downloadUrlExpiresAt && job.downloadUrlExpiresAt - now > 30_000) return;

  if (s3Client && exportBucket && job.s3Key) {
    const command = new GetObjectCommand({
      Bucket: exportBucket,
      Key: job.s3Key,
      ResponseContentType: "application/zip",
      ResponseContentDisposition: `attachment; filename="${job.zipName}"`,
    });
    const signed = await getSignedUrl(s3Client, command, { expiresIn: EXPORT_URL_TTL_SECONDS });
    job.downloadUrl = signed;
    job.downloadUrlExpiresAt = now + EXPORT_URL_TTL_SECONDS * 1000;
  } else {
    job.downloadUrl = `/api/extract-zip/jobs/${job.id}/download`;
    job.downloadUrlExpiresAt = null;
  }
  job.updatedAt = now;
  persistExportJob(job);
}

function assertNotCancelled(job: ExportJob, abortSignal: AbortSignal): void {
  if (abortSignal.aborted || job.status === "cancelled") {
    throw new Error("job cancelled");
  }
}

async function processExportJob(job: ExportJob): Promise<void> {
  const abortController = new AbortController();
  exportAbortControllers.set(job.id, abortController);

  try {
    job.status = "running";
    job.progress = 10;
    job.updatedAt = Date.now();
    persistExportJob(job);
    assertNotCancelled(job, abortController.signal);

    const resolvedSrcPath = ensureSegmentPath(job.segmentName);
    const srcFile = Bun.file(resolvedSrcPath);
    if (!await srcFile.exists()) throw new Error("Segment not found");
    const srcSize = srcFile.size;
    if (!Number.isFinite(srcSize) || srcSize <= 0) throw new Error("Segment is empty or unavailable");
    if (job.offset > srcSize) throw new Error(`offset exceeds segment size (${srcSize})`);
    assertNotCancelled(job, abortController.signal);

    const { truncatedResolved, otsResolved } = await resolveExtractOutputs(resolvedSrcPath, job.offset);
    job.progress = 55;
    job.updatedAt = Date.now();
    persistExportJob(job);
    assertNotCancelled(job, abortController.signal);

    const zipBytes = await buildZipBytesFromOutputs(truncatedResolved, otsResolved);
    job.progress = 75;
    job.updatedAt = Date.now();
    persistExportJob(job);
    assertNotCancelled(job, abortController.signal);

    if (s3Client && exportBucket) {
      job.status = "uploading";
      job.updatedAt = Date.now();
      persistExportJob(job);
      const s3Key = `${exportPrefix}/${job.id}/${job.zipName}`;
      await s3Client.send(new PutObjectCommand({
        Bucket: exportBucket,
        Key: s3Key,
        Body: zipBytes,
        ContentType: "application/zip",
        ContentDisposition: `attachment; filename="${job.zipName}"`,
      }));
      job.s3Key = s3Key;
      job.zipPath = null;
    } else {
      await Bun.write(job.zipPath!, zipBytes);
      job.s3Key = null;
    }
    assertNotCancelled(job, abortController.signal);

    job.status = "done";
    job.progress = 100;
    job.completedAt = Date.now();
    job.error = null;
    job.updatedAt = Date.now();
    persistExportJob(job);
    await ensureJobDownloadUrl(job);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "job cancelled") {
      job.status = "cancelled";
      job.error = null;
      if (job.zipPath) {
        const zipPath = job.zipPath;
        void Bun.file(job.zipPath).exists().then((exists) => {
          if (exists) return Bun.file(zipPath).delete();
        }).catch(() => {});
      }
    } else {
      job.status = "failed";
      job.error = msg;
    }
    job.updatedAt = Date.now();
    job.completedAt = Date.now();
    persistExportJob(job);
  } finally {
    exportAbortControllers.delete(job.id);
  }
}

function createExportJob(segmentName: string, offset: number): ExportJob {
  const now = Date.now();
  pruneOldExportJobs(now);

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("offset must be a non-negative number");
  }

  const id = randomUUID();
  const zipName = sanitizeZipName(segmentName, offset);
  const zipPath = join(exportDir, `${id}.zip`);
  const job: ExportJob = {
    id,
    segmentName,
    offset,
    status: "queued",
    progress: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    zipName,
    zipPath,
    s3Key: null,
    downloadUrl: null,
    downloadUrlExpiresAt: null,
  };

  exportJobs.set(id, job);
  persistExportJob(job);
  void processExportJob(job);
  return job;
}

function hydrateExportJobsFromDb(): void {
  const now = Date.now();
  const rows = getRecentExportJobs(300);
  for (const row of rows) {
    const job = fromExportJobRecord(row);
    if (job.status === "queued" || job.status === "running" || job.status === "uploading") {
      job.status = "failed";
      job.error = "interrupted by server restart";
      job.updatedAt = now;
      job.completedAt = now;
      persistExportJob(job);
    }
    exportJobs.set(job.id, job);
  }
  pruneOldExportJobs(now);
}

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

const watchers = new Map<string, SegmentWatcher>();
const ffmpegProcesses = new Map<string, FfmpegProcess>();

function allActiveSegments(): string[] {
  return [...watchers.values()].flatMap((watcher) => watcher.activeSegments());
}

// ---------------------------------------------------------------------------
// Hono app + WebSocket
// ---------------------------------------------------------------------------

const app = new Hono();
const { upgradeWebSocket, websocket } = createBunWebSocket();

// ---------------------------------------------------------------------------
// Pre-compress hls.min.js once at startup (~542KB → ~170KB)
let hlsJsGzipped: Uint8Array | null = null;
Bun.file("./src/vendor/hls.min.js").arrayBuffer().then((buf) => {
  hlsJsGzipped = Bun.gzipSync(new Uint8Array(buf));
}).catch(() => {});

// ---------------------------------------------------------------------------
// Static routes
// ---------------------------------------------------------------------------

app.get("/", async (c) => {
  const file = Bun.file("./src/frontend.html");
  return c.html(await file.text(), 200, {
    "Cache-Control": "no-store",
  });
});

app.get("/favicon.ico", async (c) => {
  const file = Bun.file("./src/favicon.ico");
  return c.body(await file.arrayBuffer(), {
    headers: { "Content-Type": "image/x-icon" },
  });
});

app.get("/favicon.png", async (c) => {
  const file = Bun.file("./src/favicon.png");
  return c.body(await file.arrayBuffer(), {
    headers: { "Content-Type": "image/png" },
  });
});

app.get("/apple-touch-icon.png", async (c) => {
  const file = Bun.file("./src/apple-touch-icon.png");
  return c.body(await file.arrayBuffer(), {
    headers: { "Content-Type": "image/png" },
  });
});

app.get("/og-image.png", async (c) => {
  const file = Bun.file("./src/og-image.png");
  return c.body(await file.arrayBuffer(), {
    headers: { "Content-Type": "image/png" },
  });
});

app.get("/og-image.webp", async (c) => {
  const file = Bun.file("./src/og-image.webp");
  return c.body(await file.arrayBuffer(), {
    headers: { "Content-Type": "image/webp" },
  });
});

app.get("/vendor/hls.min.js", async (c) => {
  const acceptEncoding = c.req.header("Accept-Encoding") ?? "";
  if (hlsJsGzipped && acceptEncoding.includes("gzip")) {
    return new Response(hlsJsGzipped, {
      headers: {
        "Content-Type": "application/javascript",
        "Content-Encoding": "gzip",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Vary": "Accept-Encoding",
      },
    });
  }
  return new Response(await Bun.file("./src/vendor/hls.min.js").arrayBuffer(), {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.get("/stream/*", async (c) => {
  const requestPath = c.req.path.replace(/^\/stream\//, "");
  if (!requestPath || requestPath.includes("..") || requestPath.startsWith("/")) {
    return c.text("Forbidden", 403);
  }
  const filePath = `${hlsDir}/${requestPath}`;
  const file = Bun.file(filePath);
  if (!await file.exists()) return c.text("Not Found", 404);
  let contentType = "application/octet-stream";
  if (requestPath.endsWith(".m3u8")) contentType = "application/vnd.apple.mpegurl";
  else if (requestPath.endsWith(".ts")) contentType = "video/mp2t";
  return c.body(await file.arrayBuffer(), {
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    },
  });
});

app.get("/assets/*", async (c) => {
  const requestPath = c.req.path.replace(/^\/assets\//, "");
  if (!requestPath || requestPath.includes("..") || requestPath.startsWith("/")) {
    return c.text("Forbidden", 403);
  }

  const filePath = `./src/assets/${requestPath}`;
  const file = Bun.file(filePath);
  if (!await file.exists()) return c.text("Not Found", 404);

  let contentType = "application/octet-stream";
  if (requestPath.endsWith(".svg")) contentType = "image/svg+xml";
  else if (requestPath.endsWith(".png")) contentType = "image/png";
  else if (requestPath.endsWith(".jpg") || requestPath.endsWith(".jpeg")) contentType = "image/jpeg";
  else if (requestPath.endsWith(".webp")) contentType = "image/webp";

  return c.body(await file.arrayBuffer(), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    },
  });
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
        .filter((f) => isPrimarySegmentName(f))
        .sort()
        .map(async (f) => {
          const fullPath = join(segmentDir, f);
          const s = await stat(fullPath).catch(() => null);
          const active = allActiveSegments().includes(f);
          const cameraId = findCameraBySegmentName(f)?.id ?? "default";
          return {
            name: f,
            cameraId,
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
        const candidates = extractOutputCandidates(body.src_path, body.offset);
        for (const candidate of candidates) {
          const exists = await Bun.file(candidate.truncatedPath).exists()
            && await Bun.file(candidate.otsPath).exists();
          if (exists) {
            return c.json({
              truncatedPath: candidate.truncatedPath,
              otsPath: candidate.otsPath,
              alreadyExisted: true,
            });
          }
        }
      }
      return c.json({ error: "Output files already exist: " + msg }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

app.post("/api/extract-zip", async (c) => {
  let body: {
    segment_name?: string;
    offset?: number;
  };

  try { body = await c.req.json(); }
  catch { return c.json({ error: "Invalid JSON body" }, 400); }

  if (!otslogBin) return c.json({ error: "otslog-bin not configured" }, 500);
  if (!body.segment_name) return c.json({ error: "segment_name is required" }, 400);
  if (body.offset === undefined) return c.json({ error: "offset is required" }, 400);
  try {
    const job = createExportJob(body.segment_name, Number(body.offset));
    return c.json({
      job_id: job.id,
      status: job.status,
      progress: job.progress,
    }, 202);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Invalid segment_name") || msg.includes("offset")) {
      return c.json({ error: msg }, 400);
    }
    return c.json({ error: msg }, 500);
  }
});

app.get("/api/extract-zip/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = exportJobs.get(id) ?? (() => {
    const row = getExportJob(id);
    if (!row) return null;
    const loaded = fromExportJobRecord(row);
    exportJobs.set(id, loaded);
    return loaded;
  })();
  if (!job) return c.json({ error: "job not found" }, 404);

  await ensureJobDownloadUrl(job);

  return c.json({
    job_id: job.id,
    segment_name: job.segmentName,
    offset: job.offset,
    status: job.status,
    progress: job.progress,
    error: job.error,
    download_url: job.status === "done" ? job.downloadUrl : null,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt,
  });
});

app.get("/api/extract-zip/jobs/:id/download", async (c) => {
  const id = c.req.param("id");
  const job = exportJobs.get(id) ?? (() => {
    const row = getExportJob(id);
    if (!row) return null;
    const loaded = fromExportJobRecord(row);
    exportJobs.set(id, loaded);
    return loaded;
  })();
  if (!job) return c.json({ error: "job not found" }, 404);
  if (job.status === "cancelled") return c.json({ error: "job cancelled" }, 409);
  if (job.status !== "done") return c.json({ error: "job not ready" }, 409);

  if (job.zipPath) {
    const file = Bun.file(job.zipPath);
    if (!await file.exists()) {
      return c.json({ error: "artifact not found" }, 404);
    }
    return c.body(await file.arrayBuffer(), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${job.zipName}"`,
      },
    });
  }

  await ensureJobDownloadUrl(job);
  if (!job.downloadUrl) return c.json({ error: "download URL unavailable" }, 500);
  return c.redirect(job.downloadUrl, 302);
});

app.delete("/api/extract-zip/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = exportJobs.get(id) ?? (() => {
    const row = getExportJob(id);
    if (!row) return null;
    const loaded = fromExportJobRecord(row);
    exportJobs.set(id, loaded);
    return loaded;
  })();
  if (!job) return c.json({ error: "job not found" }, 404);

  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
    return c.json({
      job_id: job.id,
      status: job.status,
      progress: job.progress,
      already_finished: true,
    });
  }

  const controller = exportAbortControllers.get(job.id);
  if (controller) controller.abort();
  job.status = "cancelled";
  job.error = null;
  job.completedAt = Date.now();
  job.updatedAt = Date.now();
  persistExportJob(job);

  return c.json({
    job_id: job.id,
    status: job.status,
    progress: job.progress,
  });
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
    stamping: allActiveSegments(),
    clients: stampClients.size,
    segmentDir,
    retention: retentionStats,
    cameras: cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      hlsUrl: camera.hlsUrl,
      segmentPrefix: camera.segmentPrefix,
    })),
  });
});

app.get("/api/stamps", (c) => {
  const segment = c.req.query("segment");
  const limit = parseInt(c.req.query("limit") || "1000", 10);
  if (segment) {
    return c.json({ stamps: getStampsBySegment(segment) });
  }
  return c.json({ stamps: getAllStamps(limit) });
});

app.get("/api/segments-sql", (c) => {
  return c.json({ segments: getSegments() });
});

app.get("/api/stamp-counts", (c) => {
  const camera = c.req.query("camera");
  return c.json({ counts: getStampCounts(camera || undefined) });
});

app.get("/api/cameras", (c) => {
  return c.json({
    cameras: cameras.map((camera) => ({
      id: camera.id,
      name: camera.name,
      hlsUrl: camera.hlsUrl,
    })),
  });
});

// Single endpoint for initial page load — replaces 4 sequential calls
app.get("/api/init", async (c) => {
  const { readdir, stat } = await import("node:fs/promises");
  const [files, dbSegs, counts] = await Promise.all([
    readdir(segmentDir).catch(() => [] as string[]),
    Promise.resolve(getSegments()),
    Promise.resolve(getStampCounts()),
  ]);
  const segments = await Promise.all(
    files
      .filter((f) => isPrimarySegmentName(f))
      .sort()
      .map(async (f) => {
        const fullPath = join(segmentDir, f);
        const s = await stat(fullPath).catch(() => null);
        const active = allActiveSegments().includes(f);
        const cameraId = findCameraBySegmentName(f)?.id ?? "default";
        return { name: f, cameraId, path: fullPath, size: s?.size ?? 0, mtime: s?.mtime?.toISOString() ?? null, stamping: active };
      })
  );
  return c.json({
    cameras: cameras.map((cam) => ({ id: cam.id, name: cam.name, hlsUrl: cam.hlsUrl })),
    segments,
    dbSegments: dbSegs,
    stampCounts: counts,
  });
});

app.post("/api/internal/stamp-event", (c) => {
  let body: { segment?: string; line?: string; status?: string };
  try { body = c.req.json(); }
  catch { return c.json({ error: "Invalid JSON" }, 400); }

  const segment = body.segment ?? "unknown";
  const line = body.line;
  const status = body.status;

  if (status) {
    broadcastStatus(segment, status);
  } else if (line) {
    broadcastLine(segment, line);
  }

  return c.json({ ok: true });
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

      // Send active segments status (watchers.size > 0 means stamping is running)
      ws.send(JSON.stringify({
        status: watchers.size > 0
          ? "started"
          : "idle",
      }));

      // Replay recent history (status entries use { status } so frontend updates state)
      for (const entry of stampBuffer) {
        const isStatus = /\]\s+(started|done|error|running|exited|idle|stopping)/.test(entry);
        ws.send(JSON.stringify(isStatus ? { status: entry } : { line: entry }));
      }
    },

    onMessage(event, ws) {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.action === "stop") {
          for (const watcher of watchers.values()) watcher.stop();
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
  for (const proc of ffmpegProcesses.values()) proc.stop();
  ffmpegProcesses.clear();
  for (const watcher of watchers.values()) watcher.stop();
  watchers.clear();
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
  console.log("[clean] removing segments/ and otslog artifacts...");
  for (const dir of [segmentDir]) {
    try {
      const entries = await readdir(dir);
      await Promise.all(entries.map(e => rm(join(dir, e), { recursive: true, force: true })));
    } catch {}
  }
  console.log("[clean] clearing database...");
  clearDb();
  console.log("[clean] done");
}

async function pruneOldSegmentsAndDb(): Promise<{ prunedSegments: number; orphanDbDeletes: number }> {
  const { readdir, stat, rm } = await import("node:fs/promises");

  const files = await readdir(segmentDir).catch(() => [] as string[]);
  const filesSet = new Set(files);
  const active = new Set(allActiveSegments());
  const now = Date.now();
  const retentionMs = segmentRetentionHours * 60 * 60 * 1000;
  let prunedSegments = 0;
  let orphanDbDeletes = 0;

  for (const file of files) {
    if (!isPrimarySegmentName(file)) continue;
    if (active.has(file)) continue;

    const fullPath = join(segmentDir, file);
    const s = await stat(fullPath).catch(() => null);
    if (!s) continue;

    const ageMs = now - s.mtimeMs;
    if (ageMs < retentionMs) continue;

    const base = file.replace(/\.mp4$/i, "");
    const related = files.filter((entry) => {
      if (entry === file) return true;
      if (entry === `${file}.otslog`) return true;
      if (entry.startsWith(`${base}[`)) return true;
      return false;
    });

    let deletionFailed = false;

    for (const entry of related) {
      const target = join(segmentDir, entry);
      try {
        await rm(target, { force: true, recursive: true });
      } catch (error) {
        deletionFailed = true;
        console.error(`[retention] failed to remove ${entry}:`, error);
      }
      filesSet.delete(entry);
    }

    if (deletionFailed) {
      console.warn(`[retention] skipped DB delete for ${file} because one or more files failed to delete`);
      continue;
    }

    deleteSegmentData(file);
    prunedSegments += 1;
    console.log(`[retention] pruned ${file} (${Math.round(ageMs / 1000)}s old)`);
  }

  for (const seg of getSegments()) {
    if (!filesSet.has(seg.name)) {
      deleteSegmentData(seg.name);
      orphanDbDeletes += 1;
    }
  }

  return { prunedSegments, orphanDbDeletes };
}

function startSegmentRetentionCleaner() {
  retentionStats.enabled = true;

  const run = async () => {
    try {
      const result = await pruneOldSegmentsAndDb();
      retentionStats.lastRunAt = Date.now();
      retentionStats.lastError = null;
      retentionStats.lastPrunedSegments = result.prunedSegments;
      retentionStats.lastOrphanDbDeletes = result.orphanDbDeletes;
      retentionStats.totalPrunedSegments += result.prunedSegments;
      retentionStats.totalOrphanDbDeletes += result.orphanDbDeletes;

      if (result.prunedSegments > 0 || result.orphanDbDeletes > 0) {
        console.log(`[retention] run complete: pruned=${result.prunedSegments}, orphan_db_deleted=${result.orphanDbDeletes}`);
      }
    } catch (error) {
      retentionStats.lastRunAt = Date.now();
      retentionStats.lastError = error instanceof Error ? error.message : String(error);
      console.error("[retention] prune failed:", error);
    }
  };

  void run();
  const timer = setInterval(() => {
    void run();
  }, segmentCleanupIntervalSeconds * 1000);
  timer.unref?.();

  console.log(`[retention] enabled (older than ${segmentRetentionHours}h, interval ${segmentCleanupIntervalSeconds}s)`);
}

// ---------------------------------------------------------------------------
// Boot: ffmpeg
// ---------------------------------------------------------------------------

async function autoStartFfmpeg() {
  if (noFfmpeg) {
    console.log("[boot] ffmpeg auto-start disabled (--no-ffmpeg)");
    return;
  }
  if (cameras.length === 0) {
    console.log("[boot] no cameras configured — skipping ffmpeg.");
    return;
  }

  for (const camera of cameras) {
    try {
      const proc = await startFfmpeg({
        rtspUrl: camera.rtspUrl,
        segmentDir,
        hlsDir: camera.localHls ? hlsDir : undefined,
        cameraId: camera.localHls ? camera.id : undefined,
        segmentTime,
        segmentPrefix: camera.segmentPrefix,
        bin: ffmpegBin,
        instanceKey: camera.id,
      });
      ffmpegProcesses.set(camera.id, proc);

      (async () => {
        for await (const line of proc.lines) {
          if (line.includes("Error") || line.includes("error") || line.includes("Output #")) {
            console.log(`[ffmpeg:${camera.id}] ${line}`);
          }
        }
        console.log(`[ffmpeg:${camera.id}] rotation stopped`);
      })();

      console.log(`[boot] ffmpeg started for ${camera.id} (segment-time=${segmentTime}s)`);
    } catch (err) {
      console.error(`[boot] failed to start ffmpeg for ${camera.id}:`, err);
    }
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
  if (cameras.length === 0) {
    console.log("[boot] no cameras configured — skipping segment watcher.");
    return;
  }

  for (const camera of cameras) {
    const watcher = new SegmentWatcher({
      segmentDir,
      segmentPrefix: camera.segmentPrefix,
      otslogBin,
      followInterval,
      idleTimeout,
      timeoutSeconds: stampTimeoutSeconds,
      minAttestations: stampMinAttestations,
      aggregators: stampAggregators,
      onLine: (segment, line) => {
        const segName = basename(segment)!;
        console.log(`[otslog:${camera.id}:${segName}] ${line}`);
        broadcastLine(segment, line);

        const stampMatch = line.match(/^Stamped\s+offset=(\d+)\s+time=(\d+)\s+midstate=([0-9a-f]+)/i);
        if (stampMatch) {
          saveStamp({
            segment_name: segName,
            offset: parseInt(stampMatch[1]!, 10),
            time: parseInt(stampMatch[2]!, 10),
            midstate: stampMatch[3]!,
          });
          saveSegment({ name: segName, camera_id: camera.id, stamping: 1 });
        }
      },
      onStatus: (segment, status, detail) => {
        const segName = basename(segment)!;
        const msg = detail ? `${status}: ${detail}` : status;
        console.log(`[otslog:${camera.id}:${segName}] ${msg}`);
        broadcastStatus(segment, msg);

        if (status === "started") {
          saveSegment({
            name: segName,
            camera_id: camera.id,
            stamping: 1,
            completed: 0,
          });
        } else if (status === "done") {
          saveSegment({
            name: segName,
            camera_id: camera.id,
            stamping: 0,
            completed: 1,
          });
        }
      },
    });

    watcher.start();
    watchers.set(camera.id, watcher);
    console.log(`[boot] segment watcher started for ${camera.id} (${segmentDir}/${camera.segmentPrefix}*.mp4, follow=${followInterval}s, idle-timeout=${idleTimeout}s, timeout=${stampTimeoutSeconds}s, min-attestations=${stampMinAttestations}, aggregators=${stampAggregators.length})`);
  }
}

async function ensureRuntimeDirs() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(segmentDir, { recursive: true });
  await mkdir(exportDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

if (clean) await cleanArtifacts();
await ensureRuntimeDirs();
hydrateExportJobsFromDb();
await autoStartFfmpeg();
autoStartWatcher();
startSegmentRetentionCleaner();

// ---------------------------------------------------------------------------
// Export for Bun
// ---------------------------------------------------------------------------

console.log(`[boot] otslog-web listening on http://localhost:${port}`);

export default {
  fetch: app.fetch,
  websocket,
  port,
};
