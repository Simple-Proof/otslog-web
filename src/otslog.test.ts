import { describe, test, expect } from "bun:test";
import { parseListLine, killStampProcess } from "./otslog.ts";
import type { ListEntry } from "./otslog.ts";

// ---------------------------------------------------------------------------
// parseListLine unit tests
// ---------------------------------------------------------------------------

describe("parseListLine", () => {
  test("parses valid TSV line", () => {
    const line = "0\toffset=12345\ttime=1700000000\tdigest=[1, 2, 3, 4]";
    const entry = parseListLine(line);
    expect(entry).toEqual({
      index: 0,
      offset: 12345,
      unixTime: 1700000000,
      digest: "[1, 2, 3, 4]",
    } satisfies ListEntry);
  });

  test("parses second entry with larger values", () => {
    const line = "5\toffset=9999999\ttime=1712345678\tdigest=[255, 128, 0, 64]";
    const entry = parseListLine(line);
    expect(entry).toEqual({
      index: 5,
      offset: 9999999,
      unixTime: 1712345678,
      digest: "[255, 128, 0, 64]",
    });
  });

  test("returns null for line with too few fields", () => {
    expect(parseListLine("0\toffset=123")).toBeNull();
  });

  test("returns null for line with bad index", () => {
    expect(parseListLine("abc\toffset=123\ttime=456\tdigest=foo")).toBeNull();
  });

  test("returns null for line with malformed offset", () => {
    expect(parseListLine("0\tbadoffset=123\ttime=456\tdigest=foo")).toBeNull();
  });

  test("returns null for line with malformed time", () => {
    expect(parseListLine("0\toffset=123\tbadtime=456\tdigest=foo")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseListLine("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stampFollow filtering test (using a mock script)
// ---------------------------------------------------------------------------

describe("stampFollow dbg filtering", () => {
  test("filters out lines starting with [src/", async () => {
    // Create a mock script that writes to stderr like otslog would
    const mockScript = `
      process.stderr.write("[src/bin/otslog.rs:99:5] &args = Cli { quiet: 0 }\\n");
      process.stderr.write("[src/bin/otslog.rs:125:29] otslog.last_entry()? = None\\n");
      process.stderr.write("Stamped offset 1024\\n");
      process.stderr.write("[src/bin/otslog.rs:216] truncated = \\"test.1024\\"\\n");
      process.stderr.write("No new data at offset 1024\\n");
    `;

    // Write mock script to a temp file
    const tmpPath = "/tmp/otslog-mock-stamp.mjs";
    await Bun.write(tmpPath, mockScript);

    // Spawn node with the mock script, pipe stderr
    const proc = Bun.spawn(["node", tmpPath], {
      stdout: "ignore",
      stderr: "pipe",
    });

    const { splitLines } = await import("./line-splitter.ts");

    const lines: string[] = [];
    for await (const line of splitLines(proc.stderr as ReadableStream<Uint8Array>)) {
      if (!line.startsWith("[src/")) {
        lines.push(line);
      }
    }

    await proc.exited;

    expect(lines).toEqual([
      "Stamped offset 1024",
      "No new data at offset 1024",
    ]);
  });
});

// ---------------------------------------------------------------------------
// killStampProcess
// ---------------------------------------------------------------------------

describe("killStampProcess", () => {
  test("returns false when no active process", () => {
    expect(killStampProcess()).toBe(false);
  });
});
