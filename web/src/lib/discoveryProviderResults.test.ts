import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWorks } from "../../../worker/src/lib/openalex";
import { searchArxiv } from "../../../worker/src/lib/arxiv";
import { fetchFeed } from "../../../worker/src/lib/rss";

describe("discovery provider outcomes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a normal empty response distinct from an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 })));
    await expect(searchWorks("photography", 1)).resolves.toMatchObject({ status: "OK", items: [] });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 })));
    await expect(searchWorks("photography", 1)).resolves.toMatchObject({ status: "HTTP_ERROR", items: [] });
  });

  it("reports provider timeouts instead of treating them as empty search results", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" })));
    await expect(searchArxiv("visual culture", 1)).resolves.toMatchObject({ status: "TIMEOUT", items: [] });
  });

  it("reports malformed feeds as parse errors", async () => {
    const response = withResponseUrl(
      new Response("not xml", { status: 200, headers: { "content-type": "application/xml" } }),
      "https://example.com/feed.xml",
    );
    const fetchSpy = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchSpy);

    const fetchFeedWithPolicy = fetchFeed as unknown as (
      url: string,
      limit: number,
      options: {
        resolveDns: typeof allowPublicDnsResolution;
        fetchImpl: typeof fetch;
      },
    ) => ReturnType<typeof fetchFeed>;

    await expect(fetchFeedWithPolicy("https://example.com/feed.xml", 1, {
      resolveDns: allowPublicDnsResolution,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "PARSE_ERROR", items: [] });
  });

  it("maps redirects into private targets to REDIRECT_BLOCKED", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/feed.xml" },
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const fetchFeedWithPolicy = fetchFeed as unknown as (
      url: string,
      limit: number,
      options: {
        resolveDns: typeof allowPublicDnsResolution;
        fetchImpl: typeof fetch;
      },
    ) => ReturnType<typeof fetchFeed>;

    await expect(fetchFeedWithPolicy("https://custom.example/feed.xml", 1, {
      resolveDns: allowPublicDnsResolution,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "HTTP_ERROR", errorCode: "REDIRECT_BLOCKED", items: [] });
  });

  it("maps streamed feeds above 2 MiB to SIZE_LIMIT", async () => {
    const body = new TextEncoder().encode(`<rss><channel><title>Feed</title><description>${"a".repeat((2 * 1024 * 1024) + 128)}</description></channel></rss>`);
    const oversized = makeStreamResponse([
      body.subarray(0, 1024),
      body.subarray(1024),
    ], {
      "content-type": "application/rss+xml; charset=utf-8",
    });
    const fetchSpy = vi.fn().mockResolvedValueOnce(oversized);
    vi.stubGlobal("fetch", fetchSpy);

    const fetchFeedWithPolicy = fetchFeed as unknown as (
      url: string,
      limit: number,
      options: {
        resolveDns: typeof allowPublicDnsResolution;
        fetchImpl: typeof fetch;
      },
    ) => ReturnType<typeof fetchFeed>;

    await expect(fetchFeedWithPolicy("https://custom.example/feed.xml", 1, {
      resolveDns: allowPublicDnsResolution,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    })).resolves.toMatchObject({ status: "HTTP_ERROR", errorCode: "SIZE_LIMIT", items: [] });
  });

  it("preserves exact RSS publication timestamps", async () => {
    const response = withResponseUrl(
      new Response(
        "<rss><channel><item><title>Machine Readable Photography</title><link>https://unthinking.photography/item</link><pubDate>Tue, 18 Aug 2026 00:00:00 +0000</pubDate><description>Photography and machine vision.</description></item></channel></rss>",
        { status: 200, headers: { "content-type": "application/atom+xml; charset=utf-8" } },
      ),
      "https://unthinking.photography/feed",
    );
    const fetchSpy = vi.fn().mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetchSpy);

    const fetchFeedWithPolicy = fetchFeed as unknown as (
      url: string,
      limit: number,
      options: {
        resolveDns: typeof allowPublicDnsResolution;
        fetchImpl: typeof fetch;
      },
    ) => ReturnType<typeof fetchFeed>;

    const result = await fetchFeedWithPolicy("https://unthinking.photography/feed", 1, {
      resolveDns: allowPublicDnsResolution,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(result.status).toBe("OK");
    expect(result.items[0]).toMatchObject({
      title: "Machine Readable Photography",
      year: 2026,
      publishedAt: "2026-08-18T00:00:00.000Z",
    });
  });
});

function withResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url, configurable: true });
  return response;
}

function makeStreamResponse(chunks: Uint8Array[], headers: HeadersInit, url = "https://custom.example/feed.xml"): Response {
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers,
  });

  return withResponseUrl(response, url);
}

async function allowPublicDnsResolution(_hostname: string, recordType: "A" | "AAAA"): Promise<string[]> {
  return recordType === "A" ? ["93.184.216.34"] : ["2606:2800:220:1:248:1893:25c8:1946"];
}
