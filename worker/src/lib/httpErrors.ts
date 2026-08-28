import { uuid } from "../ingestion/ids";
import type { AccessIdentity } from "./access";

export class HttpError extends Error {
  constructor(public readonly status: 400 | 401 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503, public readonly code: string, public readonly details?: unknown) {
    super(code);
    this.name = "HttpError";
  }
}

export function requestId(c: { req: { header(name: string): string | undefined }; header(name: string, value: string): void }): string {
  const incoming = c.req.header("X-Request-ID")?.trim();
  const value = incoming && /^[A-Za-z0-9._:-]{1,100}$/.test(incoming) ? incoming : uuid();
  c.header("X-Request-ID", value);
  return value;
}

export function jsonError(
  c: { req: { header(name: string): string | undefined }; header(name: string, value: string): void; json(value: unknown, status?: number): Response },
  status: number,
  error: string,
  details?: unknown,
): Response {
  const id = c.req.header("X-Request-ID") ?? requestId(c);
  return c.json({ error, requestId: id, ...(details === undefined ? {} : { details }) }, status);
}

export function verifiedRequester(c: { get(name: any): unknown }): string {
  const identity = c.get("identity") as AccessIdentity | undefined;
  return identity?.email ?? identity?.sub ?? "local";
}
