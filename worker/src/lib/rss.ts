import { cleanDiscoverySourceText } from "@radar/shared/discovery";
import type { DiscoveryProviderResult } from "@radar/shared/discoveryRun";

export interface FeedItem {
  title: string;
  url: string | null;
  year: number | null;
  summary: string | null;
}

export async function fetchFeed(url: string, limit = 5): Promise<DiscoveryProviderResult<FeedItem>> {
  const startedAt = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ResearchRadar/1.0 (personal research tool)" },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      return { status: "HTTP_ERROR", items: [], errorCode: `HTTP_${res.status}`, elapsedMs: Date.now() - startedAt };
    }
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (/xml|rss|atom/i.test(ct) || body.includes("<rss") || body.includes("<feed")) {
      if (!/<(?:rss|feed)[\s>]/i.test(body)) {
        return { status: "PARSE_ERROR", items: [], errorCode: "INVALID_XML", elapsedMs: Date.now() - startedAt };
      }
      const items = parseFeedXml(body).slice(0, limit);
      return { status: "OK", items, errorCode: null, elapsedMs: Date.now() - startedAt };
    }
    return { status: "PARSE_ERROR", items: [], errorCode: "UNSUPPORTED_FEED_FORMAT", elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      status: isTimeout ? "TIMEOUT" : "HTTP_ERROR",
      items: [],
      errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseFeedXml(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = [...xml.split(/<item[\s>]/).slice(1), ...xml.split(/<entry[\s>]/).slice(1)];
  for (const b of blocks) {
    const title = cleanDiscoverySourceText(decodeXml(tag(b, "title") ?? ""));
    if (!title) continue;
    const link =
      tag(b, "link") ??
      b.match(/<link[^>]*href="([^"]+)"/)?.[1] ??
      b.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ??
      null;
    const dateMatch = b.match(/<(?:pubDate|published|updated)>([^<]+)</);
    const year = dateMatch ? new Date(dateMatch[1]!).getFullYear() : null;
    const summary = cleanDiscoverySourceText(decodeXml(tag(b, "description") ?? tag(b, "summary") ?? ""));
    items.push({ title, url: link ? decodeXml(link) : null, year: Number.isFinite(year) ? year : null, summary: summary.slice(0, 400) || null });
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
