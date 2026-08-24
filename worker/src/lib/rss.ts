import { cleanDiscoverySourceText } from "@radar/shared/discovery";
import type { DiscoveryProviderResult } from "@radar/shared/discoveryRun";
import {
  fetchRemoteText,
  RemoteFetchError,
  type DnsResolver,
} from "../ingestion/fetchRemoteDocument";

interface FeedFetchOptions {
  resolveDns?: DnsResolver;
  fetchImpl?: typeof fetch;
}

export interface FeedItem {
  title: string;
  url: string | null;
  year: number | null;
  publishedAt: string | null;
  summary: string | null;
}

export async function fetchFeed(
  url: string,
  limit = 5,
  options: FeedFetchOptions = {},
): Promise<DiscoveryProviderResult<FeedItem>> {
  const startedAt = Date.now();
  try {
    const res = await fetchRemoteText(url, {
      maxResponseBytes: 2 * 1024 * 1024,
      resolveDns: options.resolveDns,
      fetchImpl: options.fetchImpl,
    });
    const body = new TextDecoder().decode(res.body);
    const ct = res.contentType;
    if (/xml|rss|atom/i.test(ct) || body.includes("<rss") || body.includes("<feed")) {
      if (!/<(?:rss|feed)[\s>]/i.test(body)) {
        return { status: "PARSE_ERROR", items: [], errorCode: "INVALID_XML", elapsedMs: Date.now() - startedAt };
      }
      const items = parseFeedXml(body).slice(0, limit);
      return { status: "OK", items, errorCode: null, elapsedMs: Date.now() - startedAt };
    }
    return { status: "PARSE_ERROR", items: [], errorCode: "UNSUPPORTED_FEED_FORMAT", elapsedMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof RemoteFetchError) {
      return mapRemoteFetchError(error, startedAt);
    }
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      status: isTimeout ? "TIMEOUT" : "HTTP_ERROR",
      items: [],
      errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function mapRemoteFetchError(
  error: RemoteFetchError,
  startedAt: number,
): DiscoveryProviderResult<FeedItem> {
  if (error.code === "FETCH_TIMEOUT") {
    return {
      status: "TIMEOUT",
      items: [],
      errorCode: "TIMEOUT",
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (error.code === "HTTP_4XX" || error.code === "HTTP_5XX") {
    return {
      status: "HTTP_ERROR",
      items: [],
      errorCode: error.status ? `HTTP_${error.status}` : error.code,
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (error.code === "REDIRECT_BLOCKED" || error.code === "SIZE_LIMIT" || error.code === "UNSUPPORTED_CONTENT_TYPE") {
    return {
      status: "HTTP_ERROR",
      items: [],
      errorCode: error.code,
      elapsedMs: Date.now() - startedAt,
    };
  }

  return {
    status: "HTTP_ERROR",
    items: [],
    errorCode: "NETWORK_ERROR",
    elapsedMs: Date.now() - startedAt,
  };
}

function parseFeedXml(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = [...xml.split(/<item[\s>]/).slice(1), ...xml.split(/<entry[\s>]/).slice(1)];
  for (const b of blocks) {
    const title = cleanDiscoverySourceText(tag(b, "title") ?? "");
    if (!title) continue;
    const link =
      tag(b, "link") ??
      b.match(/<link[^>]*href="([^"]+)"/)?.[1] ??
      b.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ??
      null;
    const dateMatch = b.match(/<(?:pubDate|published|updated)>([^<]+)</);
    const parsedDate = dateMatch ? new Date(decodeXml(dateMatch[1]!)) : null;
    const publishedAt = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : null;
    const year = publishedAt ? new Date(publishedAt).getUTCFullYear() : null;
    const summary = cleanDiscoverySourceText(tag(b, "description") ?? tag(b, "summary") ?? "");
    items.push({
      title,
      url: link ? decodeXml(link) : null,
      year,
      publishedAt,
      summary: summary.slice(0, 400) || null,
    });
  }
  return items;
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m?.[1] ?? null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
