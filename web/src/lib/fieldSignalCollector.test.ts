import { describe, expect, it } from "vitest";
import { collectDiscoveryFieldSignals } from "../../../worker/src/discovery/fieldSignals";

const profile = {
  original: { keywords: ["photography", "visual culture"], strength: 70 },
  counter: { keywords: [], strength: 0 },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("field signal collector", () => {
  it("tracks selected, stale, duplicate, and failed-source outcomes separately", async () => {
    const result = await collectDiscoveryFieldSignals({
      profile,
      now: new Date("2026-08-23T00:00:00.000Z"),
      existingUrls: new Set(["https://caa.example/duplicate"]),
      sources: [
        { id: "caa-news", name: "CAA News", feedUrl: "https://caa.example/feed", topicAnchors: ["visual arts", "art history"] },
        { id: "icp", name: "ICP", feedUrl: "https://icp.example/feed", topicAnchors: ["photography"] },
      ],
      rss: async (url) => {
        if (url.includes("icp")) return { status: "TIMEOUT" as const, items: [], errorCode: "TIMEOUT", elapsedMs: 12_000 };
        return {
          status: "OK" as const,
          errorCode: null,
          elapsedMs: 10,
          items: [
            { title: "Call for Papers: Photography and Visual Culture", url: "https://caa.example/cfp", year: 2026, publishedAt: "2026-08-20T00:00:00.000Z", summary: "Conference on photography and image politics." },
            { title: "Photography Conference", url: "https://caa.example/old", year: 2024, publishedAt: "2024-01-01T00:00:00.000Z", summary: "Visual culture." },
            { title: "Visual Arts Grant", url: "https://caa.example/duplicate", year: 2026, publishedAt: "2026-08-21T00:00:00.000Z", summary: "Funding opportunity." },
          ],
        };
      },
    });

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({ sourceId: "caa-news", signalType: "CALL_FOR_PAPERS" });
    expect(result.diagnostics.sources["caa-news"]).toMatchObject({
      requests: 1,
      succeededRequests: 1,
      received: 3,
      stale: 1,
      duplicate: 1,
      selected: 1,
    });
    expect(result.diagnostics.sources.icp).toMatchObject({ requests: 1, failedRequests: 1, selected: 0 });
    expect(result.diagnostics.incomplete).toBe(true);
  });

  it("caps each source at four and the whole run at twelve", async () => {
    const sources = ["a", "b", "c", "d"].map((id) => ({
      id,
      name: id.toUpperCase(),
      feedUrl: `https://${id}.example/feed`,
      topicAnchors: ["photography"],
    }));
    const result = await collectDiscoveryFieldSignals({
      profile,
      now: new Date("2026-08-23T00:00:00.000Z"),
      existingUrls: new Set<string>(),
      sources,
      rss: async (url) => ({
        status: "OK" as const,
        errorCode: null,
        elapsedMs: 1,
        items: Array.from({ length: 6 }, (_, index) => ({
          title: `Photography Workshop ${url} ${index}`,
          url: `${url}/${index}`,
          year: 2026,
          publishedAt: `2026-08-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
          summary: "Photography and visual culture workshop.",
        })),
      }),
    });

    expect(result.pending).toHaveLength(12);
    expect(Math.max(...sources.map((source) => result.pending.filter((item) => item.sourceId === source.id).length))).toBe(4);
  });
});
