import type { ExtractionMethod, TextScope } from "@radar/shared/ingestion";
import { extractStaticHtml } from "./extractHtml";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface RemoteAcquisitionInput {
  sourceId: string;
  url: string;
  version: number;
}

export interface RemoteAcquisitionResult {
  kind: "HTML" | "PDF";
  r2Key: string;
  extractedText: string;
  title: string | null;
  contentType: string;
  finalUrl: string;
  warnings: string[];
  textScope: TextScope;
  extractionMethod: ExtractionMethod;
}

export class RemoteAcquisitionError extends Error {
  constructor(readonly code: RemoteAcquisitionErrorCode) {
    super(code);
    this.name = "RemoteAcquisitionError";
  }
}

type RemoteAcquisitionErrorCode =
  | "FETCH_TIMEOUT"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "SIZE_LIMIT"
  | "REDIRECT_BLOCKED"
  | "EXTRACTION_EMPTY"
  | "PDF_CONVERSION_FAILED";

export async function acquireRemoteSource(env: Env, input: RemoteAcquisitionInput): Promise<RemoteAcquisitionResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

  try {
    const { response, finalUrl } = await fetchWithRedirects(input.url, ac.signal);
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const kind = classifyRemoteKind(contentType, finalUrl);
    if (!kind) throw new RemoteAcquisitionError("UNSUPPORTED_CONTENT_TYPE");

    const rawBody = await readResponseBody(response);
    const r2Key = buildOriginalKey(input.sourceId, input.version, kind);
    await env.ORIGINALS.put(r2Key, rawBody);

    if (kind === "PDF") {
      throw new RemoteAcquisitionError("PDF_CONVERSION_FAILED");
    }

    const html = new TextDecoder().decode(rawBody);
    const extracted = extractStaticHtml(html, finalUrl);
    if (!extracted.text.trim()) throw new RemoteAcquisitionError("EXTRACTION_EMPTY");

    return {
      kind,
      r2Key,
      extractedText: extracted.text,
      title: extracted.title || null,
      contentType,
      finalUrl,
      warnings: extracted.warnings,
      textScope: extracted.scope,
      extractionMethod: extracted.method,
    };
  } catch (error) {
    if (error instanceof RemoteAcquisitionError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new RemoteAcquisitionError("FETCH_TIMEOUT");
    throw new RemoteAcquisitionError("HTTP_5XX");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRedirects(url: string, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = validateRemoteUrl(url);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "ResearchRadar/0.1 (personal research tool)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.9,*/*;q=0.3",
      },
      redirect: "manual",
      signal,
    });

    if (isRedirectStatus(response.status)) {
      if (redirectCount === MAX_REDIRECTS) throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
      const location = response.headers.get("location");
      if (!location) throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
      currentUrl = validateRemoteUrl(new URL(location, currentUrl).toString());
      continue;
    }

    if (response.status >= 400 && response.status < 500) throw new RemoteAcquisitionError("HTTP_4XX");
    if (response.status >= 500) throw new RemoteAcquisitionError("HTTP_5XX");
    if (!response.ok) throw new RemoteAcquisitionError("HTTP_5XX");

    return { response, finalUrl: response.url || currentUrl };
  }

  throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
}

function validateRemoteUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
  }

  return parsed.toString();
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const mappedIpv4 = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  if (isPrivateIpv4(mappedIpv4)) return true;

  return normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;

  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [first = -1, second = -1] = octets;

  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeContentType(raw: string | null): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function classifyRemoteKind(contentType: string, url: string): "HTML" | "PDF" | null {
  if (contentType === "application/pdf" || /\.pdf(?:$|[?#])/i.test(url)) return "PDF";
  if (/^(?:text\/html|application\/xhtml\+xml|text\/plain)$/i.test(contentType)) return "HTML";
  return null;
}

async function readResponseBody(response: Response): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new RemoteAcquisitionError("SIZE_LIMIT");
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new RemoteAcquisitionError("SIZE_LIMIT");
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function buildOriginalKey(sourceId: string, version: number, kind: "HTML" | "PDF"): string {
  return `originals/${sourceId}/v${version}.${kind === "HTML" ? "html" : "pdf"}`;
}
