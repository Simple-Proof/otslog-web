import type { Subprocess } from "bun";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { splitLines } from "./line-splitter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FfmpegOpts {
  /** RTSP URL (with credentials). Falls back to RTSP_URL env var. */
  rtspUrl: string;
  /**
   * Directory where rotating MP4 segments will be written.
   * Segments are named output_1.mp4, output_2.mp4 … (no zero-padding)
   */
  segmentDir: string;
  /**
   * Directory where HLS playlist and .ts segments will be written.
   * If not provided, HLS is not generated locally.
   */
  hlsDir?: string;
  /**
   * Camera ID, used as subdirectory name under hlsDir.
   */
  cameraId?: string;
  /**
   * Segment duration in seconds (default: 600 = 10 minutes).
   * ffmpeg is killed and restarted with a new filename every segmentTime
   * seconds. This is done at the application level (not via -f segment)
   * because otslog requires the file to be strictly append-only, and
   * ffmpeg's segment muxer modifies earlier bytes on finalization.
   */
  segmentTime?: number;
  /** Filename prefix for segments (default: "output_") */
  segmentPrefix?: string;
  /** Path to ffmpeg binary (default: "ffmpeg") */
  bin?: string;
  instanceKey?: string;
}

export interface FfmpegProcess {
  /** Stop ffmpeg and the rotation timer */
  stop: () => void;
  /** Async line iterator over ffmpeg stderr (spans all rotations) */
  lines: AsyncGenerator<string>;
}

// ---------------------------------------------------------------------------
// Module-level process tracking
// ---------------------------------------------------------------------------

const activeFfmpegProcs = new Map<string, Subprocess>();

export function isFfmpegRunning(): boolean {
  return activeFfmpegProcs.size > 0;
}

// ---------------------------------------------------------------------------
// Build args
// ---------------------------------------------------------------------------

function buildMp4Args(opts: FfmpegOpts, segmentFile: string): string[] {
  return [
    "-rtsp_transport", "tcp",
    "-i", opts.rtspUrl,
    "-map", "0:v",
    "-c:v", "copy",
    "-an",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    segmentFile,
  ];
}

function buildHlsArgs(opts: FfmpegOpts): string[] {
  const hlsOut = `${opts.hlsDir}/${opts.cameraId}`;
  return [
    "-rtsp_transport", "tcp",
    "-i", opts.rtspUrl,
    "-map", "0:v",
    "-c:v", "copy",
    "-an",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "10",
    "-hls_flags", "delete_segments",
    `${hlsOut}/live.m3u8`,
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimum process lifetime before restarting (avoids tight crash loops) */
const MIN_LIFETIME_MS = 5_000;

/** Maximum consecutive failures before giving up (circuit breaker) */
const MAX_CONSECUTIVE_FAILURES = 10;

/** Maximum backoff delay between respawns (30 seconds) */
const MAX_BACKOFF_MS = 30_000;

/** Recovery delay after circuit breaker — gives camera time to clean stale RTSP sessions (2 minutes) */
const RECOVERY_BACKOFF_MS = 120_000;

/** Calculate backoff delay: exponential with jitter, capped at MAX_BACKOFF_MS */
function calcBackoffMs(failures: number): number {
  const base = Math.min(MIN_LIFETIME_MS * 2 ** failures, MAX_BACKOFF_MS);
  // Add 0-25% jitter to avoid thundering herd
  return Math.round(base * (1 + Math.random() * 0.25));
}

export async function startFfmpeg(opts: FfmpegOpts): Promise<FfmpegProcess> {
  const useHls = opts.hlsDir && opts.cameraId;
  const instanceKey = opts.instanceKey ?? `${opts.segmentDir}|${opts.segmentPrefix ?? "output_"}`;

  // Kill any previously running ffmpeg
  for (const [key, proc] of activeFfmpegProcs) {
    if (key.startsWith(instanceKey)) {
      proc.kill();
      activeFfmpegProcs.delete(key);
    }
  }

  await mkdir(opts.segmentDir, { recursive: true });
  if (useHls) {
    await mkdir(opts.hlsDir!, { recursive: true });
    const cameraId = opts.cameraId ?? "default";
    await mkdir(`${opts.hlsDir}/${cameraId}`, { recursive: true });
  }

  const bin = opts.bin ?? "ffmpeg";
  const segmentTime = opts.segmentTime ?? 600;
  const prefix = opts.segmentPrefix ?? "output_";

  const { readdir } = await import("node:fs/promises");
  let counter = 0;
  const files = await readdir(opts.segmentDir).catch(() => [] as string[]);
  const suffix = ".mp4";
  for (const f of files) {
    if (f.startsWith(prefix) && f.endsWith(suffix)) {
      const numStr = f.slice(prefix.length, -suffix.length);
      if (/^\d+$/.test(numStr)) {
        const num = parseInt(numStr, 10);
        if (!isNaN(num) && num >= counter) {
          counter = num + 1;
        }
      }
    }
  }
  let stopped = false;
  let mp4Proc: Subprocess | null = null;
  let hlsProc: Subprocess | null = null;
  let mp4RotationTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;

  function nextFilename(): string {
    const idx = String(counter++);
    return `${opts.segmentDir}/${prefix}${idx}.mp4`;
  }

  function spawnMp4(): Subprocess {
    const file = nextFilename();
    const args = buildMp4Args(opts, file);
    console.log(`[ffmpeg:mp4] → ${basename(file)}: ${bin} ${args.join(" ")}`);

    const proc = Bun.spawn([bin, ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });

    mp4Proc = proc;
    activeFfmpegProcs.set(`${instanceKey}:mp4`, proc);

    if (segmentTime > 0) {
      mp4RotationTimer = setTimeout(() => {
        if (mp4Proc === proc && !stopped) {
          console.log(`[ffmpeg:mp4] rotating (${segmentTime}s elapsed)`);
          proc.kill();
        }
      }, segmentTime * 1000);
    }

    return proc;
  }

  function spawnHls(): Subprocess {
    const args = buildHlsArgs(opts);
    console.log(`[ffmpeg:hls] → HLS: ${bin} ${args.join(" ")}`);

    const proc = Bun.spawn([bin, ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });

    hlsProc = proc;
    activeFfmpegProcs.set(`${instanceKey}:hls`, proc);

    return proc;
  }

  /** Kill the sibling process to free camera connections on fatal error */
  function killSibling(exclude: "mp4" | "hls") {
    if (exclude !== "hls" && hlsProc) {
      console.log(`[ffmpeg:hls] killing to free camera connection`);
      hlsProc.kill();
      hlsProc = null;
      activeFfmpegProcs.delete(`${instanceKey}:hls`);
    }
    if (exclude !== "mp4" && mp4Proc) {
      console.log(`[ffmpeg:mp4] killing to free camera connection`);
      mp4Proc.kill();
      mp4Proc = null;
      activeFfmpegProcs.delete(`${instanceKey}:mp4`);
    }
  }

  const firstMp4 = spawnMp4();
  if (useHls) {
    spawnHls();
  }

  async function* rotatingLines(): AsyncGenerator<string> {
    let mp4 = firstMp4;
    let hls = useHls && hlsProc ? hlsProc : null;
    let lastHlsRespawn = 0;

    while (!stopped) {
      const startTime = Date.now();
      let hlsRespawnedThisIteration = false;

      for await (const line of splitLines(mp4.stderr as ReadableStream<Uint8Array>)) {
        yield `[mp4] ${line}`;
      }

      // Check HLS and respawn independently (with its own cooldown)
      // Only respawn HLS if MP4 ran successfully this iteration (lifetime unknown yet).
      // If MP4 crashed (< 5s), HLS will be killed and not respawned until MP4 recovers.
      if (useHls && hlsProc && hlsProc.exited) {
        const now = Date.now();
        if (now - lastHlsRespawn < 2000) {
          console.log(`[ffmpeg:hls] died too quickly, waiting before respawn...`);
          await new Promise((r) => setTimeout(r, 2000));
          lastHlsRespawn = Date.now();
        }
        if (stopped) break;
        console.log(`[ffmpeg:hls] process died (exit code ${hlsProc.exitCode}), respawning...`);
        hlsProc = spawnHls();
        hlsRespawnedThisIteration = true;
        lastHlsRespawn = Date.now();
      }

      if (stopped) break;

      if (mp4RotationTimer) {
        clearTimeout(mp4RotationTimer);
        mp4RotationTimer = null;
      }

      const lifetime = Date.now() - startTime;

      // Process died quickly — this is a crash, not a rotation
      if (lifetime < MIN_LIFETIME_MS) {
        consecutiveFailures++;
        console.log(`[ffmpeg] process exited after ${lifetime}ms — failure ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`);

        // Kill HLS immediately to free camera connection
        if (useHls && hlsProc) {
          killSibling("mp4");
          hls = null;
          hlsRespawnedThisIteration = true; // Prevent respawn on next iteration
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[ffmpeg] circuit breaker tripped after ${consecutiveFailures} consecutive failures — waiting ${RECOVERY_BACKOFF_MS / 1000}s for camera recovery`);
          await new Promise((r) => setTimeout(r, RECOVERY_BACKOFF_MS));
          if (stopped) break;
          console.log(`[ffmpeg] recovery attempt — resetting failure counter`);
          consecutiveFailures = 0;
          // Don't decrement counter — nextFilename already advanced, go back
          if (counter > 0) counter--;
        }

        const backoffMs = calcBackoffMs(consecutiveFailures);
        console.log(`[ffmpeg] backing off ${backoffMs}ms before retry`);
        await new Promise((r) => setTimeout(r, backoffMs));

        if (stopped) break;

        mp4 = spawnMp4();
        // Don't spawn HLS during failure recovery — only spawn it on normal rotation
      } else {
        // Process ran successfully (at least MIN_LIFETIME_MS) — reset failure counter
        if (consecutiveFailures > 0) {
          console.log(`[ffmpeg] resetting failure counter (ran ${lifetime}ms)`);
        }
        consecutiveFailures = 0;

        // Normal rotation — respawn HLS only if it died AND we haven't already respawned it
        if (useHls && !hlsRespawnedThisIteration && (!hlsProc || hlsProc.exited)) {
          console.log(`[ffmpeg:hls] respawning after MP4 rotation`);
          hlsProc = spawnHls();
          hls = hlsProc;
        }

        if (stopped) break;
        mp4 = spawnMp4();
      }
    }

    activeFfmpegProcs.delete(`${instanceKey}:mp4`);
  }

  function stop() {
    stopped = true;
    if (mp4RotationTimer) {
      clearTimeout(mp4RotationTimer);
      mp4RotationTimer = null;
    }
    if (mp4Proc) {
      mp4Proc.kill();
      mp4Proc = null;
    }
    if (hlsProc) {
      hlsProc.kill();
      hlsProc = null;
    }
    activeFfmpegProcs.delete(`${instanceKey}:mp4`);
    activeFfmpegProcs.delete(`${instanceKey}:hls`);
  }

  return { stop, lines: rotatingLines() };
}
