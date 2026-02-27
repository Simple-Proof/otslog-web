import type { Subprocess } from "bun";
import { mkdir } from "node:fs/promises";
import { splitLines } from "./line-splitter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FfmpegOpts {
  /** RTSP URL (with credentials). Falls back to RTSP_URL env var. */
  rtspUrl: string;
  /**
   * Directory where rotating MP4 segments will be written.
   * Segments are named output_%03d.mp4 (output_000.mp4, output_001.mp4 …)
   */
  segmentDir: string;
  /** Segment duration in seconds (default: 600 = 10 minutes) */
  segmentTime?: number;
  /** Filename prefix for segments (default: "output_") */
  segmentPrefix?: string;
  /** Directory for HLS segments */
  hlsDir: string;
  /** HLS playlist filename inside hlsDir (default: "live.m3u8") */
  hlsPlaylist?: string;
  /** HLS segment duration in seconds (default: 4) */
  hlsTime?: number;
  /** Max playlist entries before oldest is removed (default: 10) */
  hlsListSize?: number;
  /** Path to ffmpeg binary (default: "ffmpeg") */
  bin?: string;
}

export interface FfmpegProcess {
  /** The spawned subprocess */
  proc: Subprocess;
  /** Async line iterator over ffmpeg stderr (progress/errors) */
  lines: AsyncGenerator<string>;
}

// ---------------------------------------------------------------------------
// Module-level process tracking
// ---------------------------------------------------------------------------

let activeFfmpegProc: Subprocess | null = null;

export function killFfmpegProcess(): boolean {
  if (activeFfmpegProc) {
    activeFfmpegProc.kill();
    activeFfmpegProc = null;
    return true;
  }
  return false;
}

export function isFfmpegRunning(): boolean {
  return activeFfmpegProc !== null;
}

// ---------------------------------------------------------------------------
// Build args
// ---------------------------------------------------------------------------

function buildFfmpegArgs(opts: FfmpegOpts): string[] {
  const hlsPlaylist  = opts.hlsPlaylist  ?? "live.m3u8";
  const hlsTime      = opts.hlsTime      ?? 4;
  const hlsListSize  = opts.hlsListSize  ?? 10;
  const segmentTime  = opts.segmentTime  ?? 600; // 10 minutes
  const segmentPrefix = opts.segmentPrefix ?? "output_";

  const hlsOutput     = `${opts.hlsDir}/${hlsPlaylist}`;
  const segmentOutput = `${opts.segmentDir}/${segmentPrefix}%03d.mp4`;

  return [
    // Input
    "-rtsp_transport", "tcp",
    "-i", opts.rtspUrl,

    // Output 1: rotating MP4 segments (for otslog stamping)
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-an",
    "-f", "segment",
    "-segment_time", String(segmentTime),
    "-segment_format", "mp4",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-reset_timestamps", "1",
    segmentOutput,

    // Output 2: HLS live stream
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-an",
    "-g", String(hlsTime * 25),
    "-sc_threshold", "0",
    "-f", "hls",
    "-hls_time", String(hlsTime),
    "-hls_list_size", String(hlsListSize),
    "-hls_flags", "delete_segments+independent_segments",
    hlsOutput,
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startFfmpeg(opts: FfmpegOpts): Promise<FfmpegProcess> {
  killFfmpegProcess();

  await mkdir(opts.segmentDir, { recursive: true });
  await mkdir(opts.hlsDir, { recursive: true });

  const bin  = opts.bin ?? "ffmpeg";
  const args = buildFfmpegArgs(opts);

  console.log(`[ffmpeg] spawning: ${bin} ${args.join(" ")}`);

  const proc = Bun.spawn([bin, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });

  activeFfmpegProc = proc;

  async function* stderrLines(): AsyncGenerator<string> {
    try {
      for await (const line of splitLines(proc.stderr as ReadableStream<Uint8Array>)) {
        yield line;
      }
    } finally {
      if (activeFfmpegProc === proc) {
        activeFfmpegProc = null;
      }
    }
  }

  return { proc, lines: stderrLines() };
}
