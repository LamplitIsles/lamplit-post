import { Fault } from "./errors";
/** Bound the entire decoded JSON body, including slow/dripping responses. */
export async function boundedBytes(
  response: Response,
  signal: AbortSignal,
  max = 4 * 1024 * 1024,
) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks: Uint8Array[] = [];
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const r = await reader.read();
      signal.throwIfAborted();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw new Fault("capacity");
      chunks.push(r.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
