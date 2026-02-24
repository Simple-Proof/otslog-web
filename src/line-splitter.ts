export async function* splitLines(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }

      if (done) {
        buffer += decoder.decode();
        break;
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        yield line;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (buffer.length > 0) {
    yield buffer;
  }
}
