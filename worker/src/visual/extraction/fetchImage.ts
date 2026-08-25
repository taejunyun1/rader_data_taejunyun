import { sha256Hex } from "../../ingestion/ids";
import {
  fetchSafeRemoteBytes,
  type RemoteFetchPolicy,
  RemoteFetchError,
} from "../../ingestion/fetchRemoteDocument";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_ACCEPT_HEADER = "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml,*/*;q=0.1";
const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_RIFF = "RIFF";
const WEBP_MAGIC = "WEBP";

export type RemoteImageFetchErrorCode =
  | "FETCH_TIMEOUT"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "IMAGE_URL_BLOCKED"
  | "IMAGE_TYPE_INVALID"
  | "IMAGE_SIZE_LIMIT";

export interface SafeRemoteImage {
  body: ArrayBuffer;
  byteSize: number;
  contentHash: string;
  contentType: string;
  finalUrl: string;
}

export class RemoteImageFetchError extends Error {
  constructor(readonly code: RemoteImageFetchErrorCode, readonly status?: number) {
    super(code);
    this.name = "RemoteImageFetchError";
  }
}

export async function fetchRemoteImage(
  url: string,
  policy: Omit<RemoteFetchPolicy, "accept"> = {},
): Promise<SafeRemoteImage> {
  try {
    const fetched = await fetchSafeRemoteBytes(url, {
      ...policy,
      acceptHeader: IMAGE_ACCEPT_HEADER,
      maxResponseBytes: MAX_IMAGE_BYTES,
    });
    validateImageBody(fetched.contentType, fetched.body);
    return {
      ...fetched,
      byteSize: fetched.body.byteLength,
      contentHash: await sha256Hex(fetched.body),
    };
  } catch (error) {
    if (error instanceof RemoteImageFetchError) throw error;
    if (error instanceof RemoteFetchError) throw mapRemoteFetchError(error);
    throw new RemoteImageFetchError("HTTP_5XX");
  }
}

function mapRemoteFetchError(error: RemoteFetchError): RemoteImageFetchError {
  if (error.code === "FETCH_TIMEOUT" || error.code === "HTTP_4XX" || error.code === "HTTP_5XX") {
    return new RemoteImageFetchError(error.code, error.status);
  }
  if (error.code === "SIZE_LIMIT") {
    return new RemoteImageFetchError("IMAGE_SIZE_LIMIT", error.status);
  }
  return new RemoteImageFetchError("IMAGE_URL_BLOCKED", error.status);
}

function validateImageBody(contentType: string, body: ArrayBuffer): void {
  if (contentType === "image/jpeg") {
    if (!hasJpegSignature(body)) throw new RemoteImageFetchError("IMAGE_TYPE_INVALID");
    return;
  }
  if (contentType === "image/png") {
    if (!hasFixedSignature(body, PNG_SIGNATURE)) throw new RemoteImageFetchError("IMAGE_TYPE_INVALID");
    return;
  }
  if (contentType === "image/gif") {
    if (!hasGifSignature(body)) throw new RemoteImageFetchError("IMAGE_TYPE_INVALID");
    return;
  }
  if (contentType === "image/webp") {
    if (!hasWebpSignature(body)) throw new RemoteImageFetchError("IMAGE_TYPE_INVALID");
    return;
  }
  if (contentType === "image/svg+xml") {
    if (!hasSvgSignature(body)) throw new RemoteImageFetchError("IMAGE_TYPE_INVALID");
    return;
  }
  throw new RemoteImageFetchError("IMAGE_TYPE_INVALID");
}

function hasJpegSignature(body: ArrayBuffer): boolean {
  const bytes = new Uint8Array(body);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function hasGifSignature(body: ArrayBuffer): boolean {
  const header = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(body.byteLength, 6)));
  return header === "GIF89a" || header === "GIF87a";
}

function hasWebpSignature(body: ArrayBuffer): boolean {
  const bytes = new Uint8Array(body, 0, Math.min(body.byteLength, 12));
  if (bytes.byteLength < 12) return false;
  const text = new TextDecoder().decode(bytes);
  return text.slice(0, 4) === WEBP_RIFF && text.slice(8, 12) === WEBP_MAGIC;
}

function hasSvgSignature(body: ArrayBuffer): boolean {
  const preview = new TextDecoder().decode(new Uint8Array(body, 0, Math.min(body.byteLength, 4096)));
  return /<svg\b/i.test(preview);
}

function hasFixedSignature(body: ArrayBuffer, signature: Uint8Array): boolean {
  const bytes = new Uint8Array(body, 0, Math.min(body.byteLength, signature.length));
  if (bytes.byteLength < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}
