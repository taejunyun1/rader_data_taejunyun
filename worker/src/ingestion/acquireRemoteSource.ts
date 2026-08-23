import type { ExtractionMethod, TextScope } from "@radar/shared/ingestion";
import { extractStaticHtml } from "./extractHtml";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CLOUDFLARE_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

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

export type DnsRecordType = "A" | "AAAA";
export type DnsResolver = (hostname: string, recordType: DnsRecordType) => Promise<string[]>;

interface RemoteAcquisitionOptions {
  resolveDns?: DnsResolver;
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

export async function acquireRemoteSource(
  env: Env,
  input: RemoteAcquisitionInput,
  options: RemoteAcquisitionOptions = {},
): Promise<RemoteAcquisitionResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const resolveDns = options.resolveDns ?? createDnsResolver();

  try {
    const { response, finalUrl } = await fetchWithRedirects(input.url, ac.signal, resolveDns);
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

async function fetchWithRedirects(
  url: string,
  signal: AbortSignal,
  resolveDns: DnsResolver,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = await validateRemoteUrl(url, resolveDns);

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
      currentUrl = await validateRemoteUrl(new URL(location, currentUrl).toString(), resolveDns);
      continue;
    }

    if (response.status >= 400 && response.status < 500) throw new RemoteAcquisitionError("HTTP_4XX");
    if (response.status >= 500) throw new RemoteAcquisitionError("HTTP_5XX");
    if (!response.ok) throw new RemoteAcquisitionError("HTTP_5XX");

    return { response, finalUrl: response.url || currentUrl };
  }

  throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
}

async function validateRemoteUrl(url: string, resolveDns: DnsResolver): Promise<string> {
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

  if (!(await hostnameResolvesPublicly(parsed.hostname, resolveDns))) {
    throw new RemoteAcquisitionError("REDIRECT_BLOCKED");
  }

  return parsed.toString();
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const address = parseIpAddress(normalized);
  return address ? isBlockedIpAddress(address) : false;
}

async function hostnameResolvesPublicly(hostname: string, resolveDns: DnsResolver): Promise<boolean> {
  const normalized = normalizeHostname(hostname);
  if (parseIpAddress(normalized)) return true;

  const results = await Promise.all([
    resolveDnsSafely(resolveDns, normalized, "A"),
    resolveDnsSafely(resolveDns, normalized, "AAAA"),
  ]);

  if (results.some((result) => result.failed)) return false;

  let sawAnyAnswer = false;
  for (const result of results) {
    for (const answer of result.answers) {
      sawAnyAnswer = true;
      const address = parseIpAddress(answer);
      if (!address || isBlockedIpAddress(address)) return false;
    }
  }

  return sawAnyAnswer;
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

async function resolveDnsSafely(
  resolveDns: DnsResolver,
  hostname: string,
  recordType: DnsRecordType,
): Promise<{ answers: string[]; failed: boolean }> {
  try {
    const answers = await resolveDns(hostname, recordType);
    return {
      answers: answers.filter(Boolean),
      failed: false,
    };
  } catch {
    return { answers: [], failed: true };
  }
}

function createDnsResolver(): DnsResolver {
  return async (hostname, recordType) => {
    const response = await fetch(
      `${CLOUDFLARE_DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${recordType}`,
      {
        headers: {
          Accept: "application/dns-json",
        },
      },
    );
    if (!response.ok) throw new Error("dns_lookup_failed");

    const payload = await response.json() as DnsJsonResponse;
    if (payload.Status !== 0) {
      if (payload.Status === 3) return [];
      throw new Error("dns_lookup_failed");
    }

    return (payload.Answer ?? [])
      .filter((answer) => answer.type === (recordType === "A" ? 1 : 28))
      .map((answer) => answer.data.trim());
  };
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function parseIpAddress(hostname: string): Uint8Array | null {
  const ipv4 = parseIpv4Address(hostname);
  if (ipv4) return ipv4;

  return parseIpv6Address(hostname);
}

function parseIpv4Address(hostname: string): Uint8Array | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;

  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => part < 0 || part > 255)) return null;
  return Uint8Array.from(octets);
}

function parseIpv6Address(hostname: string): Uint8Array | null {
  if (!hostname.includes(":")) return null;

  const normalized = hostname.toLowerCase();
  const lastColon = normalized.lastIndexOf(":");
  const hasIpv4Tail = lastColon >= 0 && normalized.slice(lastColon + 1).includes(".");
  const ipv4Tail = hasIpv4Tail ? parseIpv4Address(normalized.slice(lastColon + 1)) : null;
  if (hasIpv4Tail && !ipv4Tail) return null;

  const head = hasIpv4Tail ? normalized.slice(0, lastColon) : normalized;
  const halves = head.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const requiredGroups = hasIpv4Tail ? 6 : 8;
  if (!isValidIpv6Groups(left) || !isValidIpv6Groups(right)) return null;
  if (!head.includes("::") && left.length !== requiredGroups) return null;
  if (head.includes("::") && left.length + right.length > requiredGroups) return null;

  const missingGroups = requiredGroups - left.length - right.length;
  const groups = [
    ...left,
    ...new Array(Math.max(0, missingGroups)).fill("0"),
    ...right,
  ];
  if (groups.length !== requiredGroups) return null;

  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = parseInt(group, 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  });

  if (ipv4Tail) {
    bytes.set(ipv4Tail, 12);
  }

  return bytes;
}

function isValidIpv6Groups(groups: string[]): boolean {
  return groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group));
}

function isBlockedIpAddress(address: Uint8Array): boolean {
  if (address.length === 4) return isBlockedIpv4(address);

  if (isIpv4MappedIpv6(address)) {
    return isBlockedIpv4(address.slice(12));
  }

  return isBlockedIpv6(address);
}

function isBlockedIpv4(address: Uint8Array): boolean {
  const [first = -1, second = -1] = address;

  return first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19));
}

function isBlockedIpv6(address: Uint8Array): boolean {
  const first = address[0] ?? -1;
  const second = address[1] ?? -1;

  if (address.every((octet) => octet === 0)) return true;
  if (address.slice(0, 15).every((octet) => octet === 0) && address[15] === 1) return true;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true;
  return false;
}

function isIpv4MappedIpv6(address: Uint8Array): boolean {
  return address.slice(0, 10).every((octet) => octet === 0)
    && address[10] === 0xff
    && address[11] === 0xff;
}

interface DnsJsonResponse {
  Status: number;
  Answer?: Array<{
    type: number;
    data: string;
  }>;
}
