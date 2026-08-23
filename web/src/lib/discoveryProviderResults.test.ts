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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("not xml", { status: 200, headers: { "content-type": "application/xml" } })),
    );
    await expect(fetchFeed("https://example.com/feed.xml", 1)).resolves.toMatchObject({ status: "PARSE_ERROR", items: [] });
  });

  it("preserves exact RSS publication timestamps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(
          "<rss><channel><item><title>Machine Readable Photography</title><link>https://unthinking.photography/item</link><pubDate>Tue, 18 Aug 2026 00:00:00 +0000</pubDate><description>Photography and machine vision.</description></item></channel></rss>",
          { status: 200, headers: { "content-type": "application/xml" } },
        ),
      ),
    );

    const result = await fetchFeed("https://unthinking.photography/feed", 1);

    expect(result.status).toBe("OK");
    expect(result.items[0]).toMatchObject({
      title: "Machine Readable Photography",
      year: 2026,
      publishedAt: "2026-08-18T00:00:00.000Z",
    });
  });
});
