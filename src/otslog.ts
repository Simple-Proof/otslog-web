import { splitLines } from "./line-splitter.ts";
import type { Subprocess } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StampOpts {
  /** Path to the otslog binary */
  bin: string;
  /** Source file to stamp */
  srcPath: string;
  /** Optional explicit .otslog path */
  otslogPath?: string;
  /** Follow interval in seconds */
  followInterval: number;
  /** Idle timeout in seconds (stop after no new data) */
  idleTimeout?: number;
  /** Aggregator URLs */
  aggregators?: string[];
  /** Minimum attestations before timeout */
  minAttestations?: number;
  /** Stamp timeout in seconds */
  timeout?: number;
}

export interface ListOpts {
  /** Path to the otslog binary */
  bin: string;
  /** Source file */
  srcPath: string;
  /** Optional explicit .otslog path */
  otslogPath?: string;
}

export interface ListEntry {
  index: number;
  offset: number;
  unixTime: number;
  digest: string;
}

export interface ExtractOpts {
  /** Path to the otslog binary */
  bin: string;
  /** Source file */
  srcPath: string;
  /** Optional explicit .otslog path */
  otslogPath?: string;
  /** Extract by file offset */
  offset?: number;
  /** Extract by unix timestamp */
  unixTimestamp?: number;
}

export interface ExtractResult {
  /** Path to the truncated source file (FILE.OFFSET) */
  truncatedPath: string;
  /** Path to the OTS proof file (FILE.OFFSET.ots) */
  otsPath: string;
}

export interface StampFollowResult {
  /** The spawned subprocess */
  proc: Subprocess;
  /** Async iterator of filtered stderr lines */
  lines: AsyncGenerator<string>;
}

// ---------------------------------------------------------------------------
// Module-level stamp process tracking
// ---------------------------------------------------------------------------

let activeStampProc: Subprocess | null = null;

/**
 * Kill the active stamp --follow process, if any.
 */
export function killStampProcess(): boolean {
  if (activeStampProc) {
    activeStampProc.kill();
    activeStampProc = null;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lines starting with `[src/` are noisy `dbg!()` macro output from Rust */
function isDebugLine(line: string): boolean {
  return line.startsWith("[src/");
}

function buildStampArgs(opts: StampOpts): string[] {
  const args: string[] = ["stamp"];

  args.push(opts.srcPath);

  if (opts.otslogPath) {
    args.push(opts.otslogPath);
  }

  args.push("--follow", String(opts.followInterval));

  if (opts.idleTimeout !== undefined) {
    args.push("--idle-timeout", String(opts.idleTimeout));
  }

  if (opts.aggregators) {
    for (const agg of opts.aggregators) {
      args.push("-a", agg);
    }
  }

  if (opts.minAttestations !== undefined) {
    args.push("-m", String(opts.minAttestations));
  }

  if (opts.timeout !== undefined) {
    args.push("--timeout", String(opts.timeout));
  }

  return args;
}

function buildListArgs(opts: ListOpts): string[] {
  const args: string[] = ["list", opts.srcPath];
  if (opts.otslogPath) {
    args.push(opts.otslogPath);
  }
  return args;
}

function buildExtractArgs(opts: ExtractOpts): string[] {
  const args: string[] = ["extract"];

  if (opts.offset !== undefined) {
    args.push("-o", String(opts.offset));
  }

  if (opts.unixTimestamp !== undefined) {
    args.push("-t", String(opts.unixTimestamp));
  }

  args.push(opts.srcPath);

  if (opts.otslogPath) {
    args.push(opts.otslogPath);
  }

  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn `otslog stamp --follow`, pipe stderr through line-splitter,
 * filter out `dbg!()` lines. Returns the subprocess and a line iterator.
 */
export function stampFollow(opts: StampOpts): StampFollowResult {
  const args = buildStampArgs(opts);

  const proc = Bun.spawn([opts.bin, ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });

  activeStampProc = proc;

  async function* filteredLines(): AsyncGenerator<string> {
    try {
      for await (const line of splitLines(proc.stderr as ReadableStream<Uint8Array>)) {
        if (!isDebugLine(line)) {
          yield line;
        }
      }
    } finally {
      // Clean up tracking when the stream ends
      if (activeStampProc === proc) {
        activeStampProc = null;
      }
    }
  }

  return { proc, lines: filteredLines() };
}

/**
 * Run `otslog list` and parse the TSV output.
 *
 * Output format per line: `{index}\toffset={offset}\ttime={unixTime}\tdigest={digest}`
 */
export async function list(opts: ListOpts): Promise<ListEntry[]> {
  const args = buildListArgs(opts);

  const proc = Bun.spawn([opts.bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const entries: ListEntry[] = [];

  for await (const line of splitLines(proc.stdout as ReadableStream<Uint8Array>)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const entry = parseListLine(trimmed);
    if (entry) {
      entries.push(entry);
    }
  }

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    // Drain stderr for error message
    const stderrText = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`otslog list exited with code ${exitCode}: ${stderrText.trim()}`);
  }

  return entries;
}

/**
 * Parse a single line of `otslog list` output.
 *
 * Format: `0\toffset=12345\ttime=1700000000\tdigest=[1, 2, 3, ...]`
 */
export function parseListLine(line: string): ListEntry | null {
  const parts = line.split("\t");
  if (parts.length < 4) return null;

  const rawIndex = parts[0]!;
  const rawOffset = parts[1]!;
  const rawTime = parts[2]!;
  const rawDigest = parts[3]!;

  const index = parseInt(rawIndex, 10);
  if (isNaN(index)) return null;

  const offsetMatch = rawOffset.match(/^offset=(\d+)$/);
  const timeMatch = rawTime.match(/^time=(\d+)$/);
  const digestMatch = rawDigest.match(/^digest=(.+)$/);

  if (!offsetMatch || !timeMatch || !digestMatch) return null;

  return {
    index,
    offset: parseInt(offsetMatch[1]!, 10),
    unixTime: parseInt(timeMatch[1]!, 10),
    digest: digestMatch[1]!,
  };
}

/**
 * Run `otslog extract` and return the created file paths.
 *
 * Creates FILE.OFFSET and FILE.OFFSET.ots. Will fail if files already exist
 * (otslog uses create_new(true)).
 *
 * When extracting by timestamp (-t), the actual file offset is resolved
 * internally by otslog. We parse stderr dbg!() output to discover the
 * actual created paths.
 */
export async function extract(opts: ExtractOpts): Promise<ExtractResult> {
  if (opts.offset === undefined && opts.unixTimestamp === undefined) {
    throw new Error("extract requires either offset or unixTimestamp");
  }

  const args = buildExtractArgs(opts);

  const proc = Bun.spawn([opts.bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Collect stderr to parse dbg!() output for created file paths
  const stderrText = await new Response(proc.stderr as ReadableStream).text();

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`otslog extract exited with code ${exitCode}: ${stderrText.trim()}`);
  }

  // If offset is explicit, we know the exact paths
  if (opts.offset !== undefined) {
    const truncatedPath = `${opts.srcPath}.${opts.offset}`;
    return { truncatedPath, otsPath: `${truncatedPath}.ots` };
  }

  // For timestamp lookups, parse stderr for the dbg!() paths.
  // The Rust code does: dbg!(dbg!(truncated_src_path).with_added_extension("ots"))
  // which outputs lines like: [src/bin/otslog.rs:216] ... = "FILE.OFFSET.ots"
  const quotedMatch = stderrText.match(/"([^"]+\.ots)"/m);
  if (quotedMatch && quotedMatch[1]) {
    const otsPath = quotedMatch[1];
    const truncatedPath = otsPath.replace(/\.ots$/, "");
    return { truncatedPath, otsPath };
  }

  // Fallback: we can't determine paths from stderr
  throw new Error(
    "Could not determine output paths from otslog extract. " +
    "Use explicit offset instead of timestamp, or run list() first to resolve."
  );
}
