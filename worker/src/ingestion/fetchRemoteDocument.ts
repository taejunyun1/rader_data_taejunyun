const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CLOUDFLARE_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const PDF_SIGNATURE_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);
const PDF_SIGNATURE_SCAN_BYTES = 1024;

export type RemoteDocumentKind = "HTML" | "PDF";
export type RemoteFetchAccept = "DOCUMENT" | "FEED";
export type RemoteFetchErrorCode =
  | "FETCH_TIMEOUT"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "SIZE_LIMIT"
  | "REDIRECT_BLOCKED"
  | "PDF_SIGNATURE_INVALID";

export type DnsRecordType = "A" | "AAAA";
export type DnsResolver = (
  hostname: string,
  recordType: DnsRecordType,
  signal: AbortSignal,
) => Promise<string[]>;

export interface RemoteFetchPolicy {
  resolveDns?: DnsResolver;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  accept?: RemoteFetchAccept;
}

export interface SafeRemoteBytesPolicy extends RemoteFetchPolicy {
  acceptHeader?: string;
  maxRedirects?: number;
}

export interface SafeRemoteText {
  body: ArrayBuffer;
  contentType: string;
  finalUrl: string;
}

export interface SafeRemoteDocument extends SafeRemoteText {
  kind: RemoteDocumentKind;
}

export class RemoteFetchError extends Error {
  document?: SafeRemoteText;

  constructor(readonly code: RemoteFetchErrorCode, readonly status?: number) {
    super(code);
    this.name = "RemoteFetchError";
  }
}

export async function fetchRemoteDocument(
  url: string,
  policy: RemoteFetchPolicy = {},
): Promise<SafeRemoteDocument> {
  try {
    const fetched = await fetchSafeRemoteBytes(url, policy);
    return classifyRemoteDocument(fetched);
  } catch (error) {
    if (error instanceof RemoteFetchError) throw error;
    if (isAbortError(error)) throw new RemoteFetchError("FETCH_TIMEOUT");
    throw new RemoteFetchError("HTTP_5XX");
  }
}

export async function fetchRemoteText(
  url: string,
  policy: RemoteFetchPolicy = {},
): Promise<SafeRemoteText> {
  try {
    return await fetchSafeRemoteBytes(url, {
      ...policy,
      accept: "FEED",
    });
  } catch (error) {
    if (error instanceof RemoteFetchError) throw error;
    if (isAbortError(error)) throw new RemoteFetchError("FETCH_TIMEOUT");
    throw new RemoteFetchError("HTTP_5XX");
  }
}

export function normalizePublicHttpUrl(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.username || parsed.password) {
    return null;
  }

  if (isBlockedHostname(parsed.hostname)) {
    return null;
  }

  return parsed.toString();
}

export async function fetchSafeRemoteBytes(
  url: string,
  policy: SafeRemoteBytesPolicy = {},
): Promise<SafeRemoteText> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const resolveDns = policy.resolveDns ?? createDnsResolver(policy.fetchImpl ?? fetch);
  const acceptHeader = policy.acceptHeader ?? acceptHeaderFor(policy.accept ?? "DOCUMENT");
  const maxRedirects = Math.max(0, policy.maxRedirects ?? MAX_REDIRECTS);

  try {
    const { response, finalUrl } = await fetchWithRedirects(
      url,
      ac.signal,
      resolveDns,
      policy.fetchImpl ?? fetch,
      acceptHeader,
      maxRedirects,
    );
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const body = await readResponseBody(response, ac.signal, policy.maxResponseBytes ?? MAX_RESPONSE_BYTES);
    return { body, contentType, finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRedirects(
  url: string,
  signal: AbortSignal,
  resolveDns: DnsResolver,
  fetchImpl: typeof fetch,
  acceptHeader: string,
  maxRedirects: number,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = await validateRemoteUrl(url, resolveDns, signal);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        "User-Agent": "ResearchRadar/0.1 (personal research tool)",
        Accept: acceptHeader,
      },
      redirect: "manual",
      signal,
    });

    if (isRedirectStatus(response.status)) {
      if (redirectCount === maxRedirects) throw new RemoteFetchError("REDIRECT_BLOCKED", response.status);
      const location = response.headers.get("location");
      if (!location) throw new RemoteFetchError("REDIRECT_BLOCKED", response.status);
      currentUrl = await validateRemoteUrl(new URL(location, currentUrl).toString(), resolveDns, signal);
      continue;
    }

    if (response.status >= 400 && response.status < 500) throw new RemoteFetchError("HTTP_4XX", response.status);
    if (response.status >= 500) throw new RemoteFetchError("HTTP_5XX", response.status);
    if (!response.ok) throw new RemoteFetchError("HTTP_5XX", response.status);

    return { response, finalUrl: response.url || currentUrl };
  }

  throw new RemoteFetchError("REDIRECT_BLOCKED");
}

function acceptHeaderFor(accept: RemoteFetchAccept): string {
  return accept === "FEED"
    ? "application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.2"
    : "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.9,*/*;q=0.3";
}

async function validateRemoteUrl(url: string, resolveDns: DnsResolver, signal: AbortSignal): Promise<string> {
  const normalized = normalizePublicHttpUrl(url);
  if (!normalized) throw new RemoteFetchError("REDIRECT_BLOCKED");

  const parsed = new URL(normalized);
  if (!(await hostnameResolvesPublicly(parsed.hostname, resolveDns, signal))) {
    throw new RemoteFetchError("REDIRECT_BLOCKED");
  }

  return parsed.toString();
}

function classifyRemoteDocument(document: SafeRemoteText): SafeRemoteDocument {
  const htmlContent = /^(?:text\/html|application\/xhtml\+xml|text\/plain)$/i.test(document.contentType);
  if (htmlContent) {
    return {
      ...document,
      kind: "HTML",
    };
  }

  const pdfLikeUrl = /\.pdf(?:$|[?#])/i.test(document.finalUrl);
  const hasPdfSignature = containsPdfSignature(document.body);

  if (document.contentType === "application/pdf") {
    if (!hasPdfSignature) {
      const error = new RemoteFetchError("PDF_SIGNATURE_INVALID");
      error.document = document;
      throw error;
    }

    return {
      ...document,
      kind: "PDF",
    };
  }

  if (document.contentType === "application/octet-stream" && pdfLikeUrl && hasPdfSignature) {
    return {
      ...document,
      kind: "PDF",
    };
  }

  throw new RemoteFetchError("UNSUPPORTED_CONTENT_TYPE");
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    if (signal.aborted) throw abortError();
    const buffer = await response.arrayBuffer();
    if (signal.aborted) throw abortError();
    if (buffer.byteLength > maxResponseBytes) throw new RemoteFetchError("SIZE_LIMIT");
    return buffer;
  }

  let aborted = signal.aborted;
  const onAbort = () => {
    aborted = true;
    void reader.cancel(abortError()).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
      if (aborted) throw abortError();

      const { done, value } = await reader.read();
      if (aborted) throw abortError();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel("SIZE_LIMIT").catch(() => undefined);
        throw new RemoteFetchError("SIZE_LIMIT");
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return merged.buffer;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function hostnameResolvesPublicly(
  hostname: string,
  resolveDns: DnsResolver,
  signal: AbortSignal,
): Promise<boolean> {
  const normalized = normalizeHostname(hostname);
  if (parseIpAddress(normalized)) return true;

  const results = await Promise.all([
    resolveDnsSafely(resolveDns, normalized, "A", signal),
    resolveDnsSafely(resolveDns, normalized, "AAAA", signal),
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

async function resolveDnsSafely(
  resolveDns: DnsResolver,
  hostname: string,
  recordType: DnsRecordType,
  signal: AbortSignal,
): Promise<{ answers: string[]; failed: boolean }> {
  try {
    const answers = await resolveDns(hostname, recordType, signal);
    return {
      answers: answers.filter(Boolean),
      failed: false,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { answers: [], failed: true };
  }
}

function createDnsResolver(fetchImpl: typeof fetch): DnsResolver {
  return async (hostname, recordType, signal) => {
    const response = await fetchImpl(
      `${CLOUDFLARE_DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${recordType}`,
      {
        headers: {
          Accept: "application/dns-json",
        },
        signal,
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

function normalizeContentType(raw: string | null): string {
  return (raw ?? "").split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}

function containsPdfSignature(body: ArrayBuffer): boolean {
  const bytes = new Uint8Array(body, 0, Math.min(body.byteLength, PDF_SIGNATURE_SCAN_BYTES));
  for (let index = 0; index <= bytes.length - PDF_SIGNATURE_BYTES.length; index++) {
    let matched = true;
    for (let offset = 0; offset < PDF_SIGNATURE_BYTES.length; offset++) {
      if (bytes[index + offset] !== PDF_SIGNATURE_BYTES[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;

  const address = parseIpAddress(normalized);
  return address ? isBlockedIpAddress(address) : false;
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

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

interface DnsJsonResponse {
  Status: number;
  Answer?: Array<{
    type: number;
    data: string;
  }>;
}
