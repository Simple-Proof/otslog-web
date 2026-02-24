import { describe, it, expect } from "bun:test";
import { splitLines } from "./line-splitter";

function createStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function encodeString(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe("splitLines", () => {
  it("empty stream yields nothing", async () => {
    const stream = createStream([]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual([]);
  });

  it("single complete line yields that line", async () => {
    const stream = createStream([encodeString("hello\n")]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["hello"]);
  });

  it("multiple lines in one chunk", async () => {
    const stream = createStream([encodeString("line1\nline2\nline3\n")]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("line split across two chunks", async () => {
    const stream = createStream([
      encodeString("hel"),
      encodeString("lo\nworld\n"),
    ]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["hello", "world"]);
  });

  it("trailing content without newline is flushed at end", async () => {
    const stream = createStream([encodeString("line1\nline2")]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1", "line2"]);
  });

  it("large chunk with many lines", async () => {
    const largeContent = Array.from({ length: 100 }, (_, i) => `line${i}`).join(
      "\n"
    );
    const stream = createStream([encodeString(largeContent + "\n")]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines.length).toBe(100);
    expect(lines[0]).toBe("line0");
    expect(lines[99]).toBe("line99");
  });

  it("handles multiple chunks with partial lines", async () => {
    const stream = createStream([
      encodeString("a"),
      encodeString("b"),
      encodeString("c\n"),
      encodeString("d"),
      encodeString("e\n"),
    ]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["abc", "de"]);
  });

  it("handles empty lines", async () => {
    const stream = createStream([encodeString("line1\n\nline3\n")]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["line1", "", "line3"]);
  });

  it("handles UTF-8 multi-byte characters", async () => {
    const stream = createStream([encodeString("hello 世界\nfoo 🎉\n")]);
    const lines: string[] = [];

    for await (const line of splitLines(stream)) {
      lines.push(line);
    }

    expect(lines).toEqual(["hello 世界", "foo 🎉"]);
  });
});
