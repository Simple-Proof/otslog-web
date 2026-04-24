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

  let stopped = false;
  let counter = 0;
  let mp4Proc: Subprocess | null = null;
  let hlsProc: Subprocess | null = null;
  let mp4RotationTimer: ReturnType<typeof setTimeout> | null = null;

  function nextFilename(): string {
    const idx = String(counter++).padStart(3, "0");
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

      for await (const line of splitLines(mp4.stderr as ReadableStream<Uint8Array>)) {
        yield `[mp4] ${line}`;
      }

      if (useHls && hlsProc && hlsProc.exited) {
        const now = Date.now();
        if (now - lastHlsRespawn < 2000) {
          console.log(`[ffmpeg:hls] died too quickly, waiting before respawn...`);
          await new Promise((r) => setTimeout(r, 2000));
          lastHlsRespawn = Date.now();
        }
        console.log(`[ffmpeg:hls] process died (exit code ${hlsProc.exitCode}), respawning...`);
        hlsProc = spawnHls();
        lastHlsRespawn = now;
      }

      if (stopped) break;

      if (mp4RotationTimer) {
        clearTimeout(mp4RotationTimer);
        mp4RotationTimer = null;
      }

      const lifetime = Date.now() - startTime;
      if (lifetime < MIN_LIFETIME_MS) {
        if (counter > 0) counter--;
        console.log(`[ffmpeg] process exited after ${lifetime}ms — waiting before restart`);
        await new Promise((r) => setTimeout(r, MIN_LIFETIME_MS - lifetime));
      }

      if (stopped) break;

      mp4 = spawnMp4();
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
