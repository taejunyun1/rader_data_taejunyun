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
});
