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
   * Segments are named output_000.mp4, output_001.mp4 …
   */
  segmentDir: string;
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

function buildFfmpegArgs(opts: FfmpegOpts, segmentFile: string): string[] {
  return [
    // Input
    "-rtsp_transport", "tcp",
    "-i", opts.rtspUrl,

    // Output 1: growing fMP4 (for otslog stamping)
    // Uses -f mp4 (NOT -f segment) because otslog requires strict
    // append-only files. Rotation is handled by killing/restarting ffmpeg.
    "-c:v", "copy",
    "-an",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    segmentFile,
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimum process lifetime before restarting (avoids tight crash loops) */
const MIN_LIFETIME_MS = 5_000;

export async function startFfmpeg(opts: FfmpegOpts): Promise<FfmpegProcess> {
  const instanceKey = opts.instanceKey ?? `${opts.segmentDir}|${opts.segmentPrefix ?? "output_"}`;

  // Kill any previously running ffmpeg
  const previousProc = activeFfmpegProcs.get(instanceKey);
  if (previousProc) {
    previousProc.kill();
    activeFfmpegProcs.delete(instanceKey);
  }

  await mkdir(opts.segmentDir, { recursive: true });

  const bin = opts.bin ?? "ffmpeg";
  const segmentTime = opts.segmentTime ?? 600;
  const prefix = opts.segmentPrefix ?? "output_";

  let stopped = false;
  let counter = 0;
  let currentProc: Subprocess | null = null;
  let rotationTimer: ReturnType<typeof setTimeout> | null = null;

  function nextFilename(): string {
    const idx = String(counter++).padStart(3, "0");
    return `${opts.segmentDir}/${prefix}${idx}.mp4`;
  }

  function spawnSegment(): Subprocess {
    const file = nextFilename();
    const args = buildFfmpegArgs(opts, file);
    console.log(`[ffmpeg] → ${basename(file)}: ${bin} ${args.join(" ")}`);

    const proc = Bun.spawn([bin, ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });

    currentProc = proc;
    activeFfmpegProcs.set(instanceKey, proc);

    // Schedule rotation kill
    if (segmentTime > 0) {
      rotationTimer = setTimeout(() => {
        if (currentProc === proc && !stopped) {
          console.log(`[ffmpeg] rotating (${segmentTime}s elapsed)`);
          proc.kill();
        }
      }, segmentTime * 1000);
    }

    return proc;
  }

  // Spawn first segment immediately
  const firstProc = spawnSegment();

  async function* rotatingLines(): AsyncGenerator<string> {
    let proc = firstProc;

    while (!stopped) {
      const startTime = Date.now();

      for await (const line of splitLines(proc.stderr as ReadableStream<Uint8Array>)) {
        yield line;
      }

      if (stopped) break;

      // Clear stale rotation timer (process may have exited before timer fired)
      if (rotationTimer) {
        clearTimeout(rotationTimer);
        rotationTimer = null;
      }

      // Guard against tight crash loops — if ffmpeg died too quickly, wait
      const lifetime = Date.now() - startTime;
      if (lifetime < MIN_LIFETIME_MS) {
        if (counter > 0) counter--;
        console.log(`[ffmpeg] process exited after ${lifetime}ms — waiting before restart`);
        await new Promise((r) => setTimeout(r, MIN_LIFETIME_MS - lifetime));
      }

      if (stopped) break;

      proc = spawnSegment();
    }

    // Final cleanup
    if (activeFfmpegProcs.get(instanceKey) === currentProc) {
      activeFfmpegProcs.delete(instanceKey);
    }
  }

  function stop() {
    stopped = true;
    if (rotationTimer) {
      clearTimeout(rotationTimer);
      rotationTimer = null;
    }
    if (currentProc) {
      currentProc.kill();
      currentProc = null;
    }
    activeFfmpegProcs.delete(instanceKey);
  }

  return { stop, lines: rotatingLines() };
}
