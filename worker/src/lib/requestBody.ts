import { HttpError } from "./httpErrors";

export const MAX_JSON_BODY_BYTES = 1_000_000;

export function assertContentLength(c: { req: { header(name: string): string | undefined } }, maxBytes: number): void {
  const raw = c.req.header("Content-Length");
  if (!raw) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length > maxBytes) throw new HttpError(413, "request_body_too_large", { maxBytes });
}

export async function readJson<T>(c: { req: { header(name: string): string | undefined; raw: Request } }, maxBytes = MAX_JSON_BODY_BYTES): Promise<T | null> {
  assertContentLength(c, maxBytes);
  const body = c.req.raw.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new HttpError(413, "request_body_too_large", { maxBytes });
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}
