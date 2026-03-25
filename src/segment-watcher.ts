import type { Subprocess } from "bun";
import { watch } from "node:fs";
import { resolve, basename } from "node:path";
import { splitLines } from "./line-splitter.ts";
import { list } from "./otslog.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentWatcherOpts {
  /** Directory to watch for new MP4 segments */
  segmentDir: string;
  /** Glob pattern prefix — e.g. "output_" matches output_000.mp4, output_001.mp4 */
  segmentPrefix: string;
  /** Path to otslog binary */
  otslogBin: string;
  /** Follow interval in seconds */
  followInterval: number;
  /**
   * Idle timeout in seconds — otslog stops following when the file hasn't
   * grown for this long (i.e. ffmpeg has rotated to the next segment).
   * Default: 30s (a bit more than one segment duration's worth of padding).
   */
  idleTimeout?: number;
  timeoutSeconds?: number;
  minAttestations?: number;
  aggregators?: string[];
  /** Called for every line of otslog output (for broadcasting) */
  onLine: (segment: string, line: string) => void;
  /** Called when a segment's stamp process starts or stops */
  onStatus: (segment: string, status: "started" | "done" | "error", detail?: string) => void;
}

export interface ActiveSegment {
  path: string;
  proc: Subprocess;
}

// ---------------------------------------------------------------------------
// SegmentWatcher
// ---------------------------------------------------------------------------

export class SegmentWatcher {
  private opts: SegmentWatcherOpts;
  /** segment filename → active stamp subprocess */
  private active = new Map<string, Subprocess>();
  /** segments we've already started stamping (avoid double-spawn) */
  private seen = new Set<string>();
  private retryAttempts = new Map<string, number>();
  private retrying = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private fsWatcher: ReturnType<typeof watch> | null = null;
  private stopped = false;

  constructor(opts: SegmentWatcherOpts) {
    this.opts = opts;
  }

  /** Start watching the segment directory */
  start() {
    const dir = resolve(this.opts.segmentDir);

    // Scan for any segments already present on startup
    this.scanDir(dir);

    // Watch for new files
    this.fsWatcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (this.stopped) return;
      if (!filename) return;
      if (!this.isSegment(filename)) return;
      const fullPath = `${dir}/${filename}`;
      this.maybeStamp(fullPath, filename);
    });

    console.log(`[watcher] watching ${dir} for ${this.opts.segmentPrefix}*.mp4`);
  }

  /** Stop watching and kill all active stamp processes */
  stop() {
    this.stopped = true;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    for (const [seg, proc] of this.active) {
      console.log(`[watcher] killing stamp for ${seg}`);
      proc.kill();
    }
    this.active.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retrying.clear();
  }

  /** Kill stamp for a specific segment (if active) */
  killSegment(segmentName: string) {
    const proc = this.active.get(segmentName);
    if (proc) {
      proc.kill();
      this.active.delete(segmentName);
    }
    const retryTimer = this.retryTimers.get(segmentName);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(segmentName);
    }
    this.retryAttempts.delete(segmentName);
    this.retrying.delete(segmentName);
  }

  /** List of segments currently being stamped */
  activeSegments(): string[] {
    return [...new Set([...this.active.keys(), ...this.retrying])];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private isSegment(filename: string): boolean {
    if (/\[\d+\]\.mp4$/i.test(filename)) {
      return false;
    }

    return (
      filename.startsWith(this.opts.segmentPrefix) &&
      filename.endsWith(".mp4")
    );
  }

  private async scanDir(dir: string) {
    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(dir);
      for (const f of files.sort()) {
        if (this.isSegment(f)) {
          this.maybeStamp(`${dir}/${f}`, f);
        }
      }
    } catch {
      // dir might not exist yet
    }
  }

  private async maybeStamp(fullPath: string, filename: string) {
    if (this.seen.has(filename)) return;

    // Wait briefly for the file to actually exist and have some content
    // (fs watch fires on creation, file may still be 0 bytes)
    await this.waitForContent(fullPath);
    if (this.stopped) return;
    if (this.seen.has(filename)) return; // double-check after await

    this.seen.add(filename);
    this.spawnStamp(fullPath, filename);
  }

  private async waitForContent(path: string, timeoutMs = 10_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const file = Bun.file(path);
      if (await file.exists() && (await file.size) > 0) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private spawnStamp(fullPath: string, filename: string) {
    const { otslogBin, followInterval, idleTimeout = 30, timeoutSeconds, minAttestations, aggregators } = this.opts;

    const args = [
      "stamp",
      fullPath,
      "--follow", String(followInterval),
      "--idle-timeout", String(idleTimeout),
    ];

    if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
      args.push("--timeout", String(timeoutSeconds));
    }

    if (typeof minAttestations === "number" && Number.isFinite(minAttestations) && minAttestations > 0) {
      args.push("-m", String(minAttestations));
    }

    if (Array.isArray(aggregators) && aggregators.length > 0) {
      for (const agg of aggregators) {
        if (!agg) continue;
        args.push("-a", agg);
      }
    }

    console.log(`[watcher] stamping ${filename}: ${otslogBin} ${args.join(" ")}`);

    const proc = Bun.spawn([otslogBin, ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });

    this.retrying.delete(filename);
    const retryTimer = this.retryTimers.get(filename);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(filename);
    }

    this.active.set(filename, proc);
    this.opts.onStatus(filename, "started");

    // Drain stderr → filter debug lines → broadcast
    (async () => {
      let sawIdleStop = false;
      let sawPanic = false;

      try {
        for await (const line of splitLines(proc.stderr as ReadableStream<Uint8Array>)) {
          if (line.startsWith("[src/")) continue; // Rust dbg!() noise

          const lower = line.toLowerCase();
          if (lower.includes("idle for") && lower.includes("stopping")) {
            sawIdleStop = true;
          }
          if (lower.includes("panicked") || lower.includes("fixme: handle timeouts")) {
            sawPanic = true;
          }

          this.opts.onLine(filename, line);
        }
      } finally {
        this.active.delete(filename);

        if (this.stopped) {
          return;
        }

        const shouldRetry = await this.shouldRetryAfterExit(fullPath, idleTimeout, sawIdleStop);
        let retryReason: string | null = null;

        if (shouldRetry) {
          retryReason = sawPanic ? "panic/timeout" : "unexpected exit";
        } else {
          const entryCount = await this.countStampEntries(fullPath);
          if (entryCount <= 0) {
            retryReason = "verification failed (0 stamp entries)";
          }
        }

        if (retryReason) {
          const attempt = (this.retryAttempts.get(filename) ?? 0) + 1;
          this.retryAttempts.set(filename, attempt);
          const backoffMs = this.retryDelayMs(attempt);
          this.retrying.add(filename);

          console.warn(`[watcher] stamp ${retryReason} for ${filename}; retrying in ${backoffMs}ms (attempt ${attempt})`);
          this.opts.onLine(filename, `stamp ${retryReason}; retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt})`);

          const timer = setTimeout(() => {
            this.retryTimers.delete(filename);
            if (this.stopped) return;
            if (this.active.has(filename)) return;
            this.spawnStamp(fullPath, filename);
          }, backoffMs);
          this.retryTimers.set(filename, timer);
          return;
        }

        this.retryAttempts.delete(filename);
        this.retrying.delete(filename);
        console.log(`[watcher] stamp finished for ${filename}`);
        this.opts.onStatus(filename, "done");
      }
    })();
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(10_000, 500 * Math.pow(2, Math.max(0, attempt - 1)));
  }

  private async shouldRetryAfterExit(fullPath: string, idleTimeout: number, sawIdleStop: boolean): Promise<boolean> {
    if (sawIdleStop) return false;

    const { stat } = await import("node:fs/promises");
    const first = await stat(fullPath).catch(() => null);
    if (!first) return false;

    const idleWindowMs = idleTimeout * 1000;
    const ageMs = Date.now() - first.mtimeMs;
    if (ageMs > idleWindowMs + 2_000) {
      return false;
    }

    await new Promise((r) => setTimeout(r, 1_000));
    const second = await stat(fullPath).catch(() => null);
    if (!second) return false;

    if (second.size > first.size) {
      return true;
    }

    const ageAfterWaitMs = Date.now() - second.mtimeMs;
    return ageAfterWaitMs <= idleWindowMs;
  }

  private async countStampEntries(fullPath: string): Promise<number> {
    try {
      const entries = await list({
        bin: this.opts.otslogBin,
        srcPath: fullPath,
      });
      return entries.length;
    } catch {
      return 0;
    }
  }
}
