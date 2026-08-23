import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../worker/src/lib/rss", () => ({
  fetchFeed: vi.fn(),
}));

import { fetchFeed } from "../../../worker/src/lib/rss";
import { collectDiscoveryFieldSignals, runDiscoveryFieldSignals } from "../../../worker/src/discovery/fieldSignals";

const profile = {
  original: { keywords: ["photography", "visual culture"], strength: 70 },
  counter: { keywords: [], strength: 0 },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

const mockedFetchFeed = vi.mocked(fetchFeed);

afterEach(() => {
  mockedFetchFeed.mockReset();
});

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
    expect(Math.max(...sources.map((source) => result.pending.filter((item) => item.sourceId === source.id).length))).toBeLessThanOrEqual(4);
  });

  it("globally ranks a later source ahead of earlier sources before the run cap", async () => {
    const earlySources = ["a", "b", "c"].map((id) => ({
      id,
      name: id.toUpperCase(),
      feedUrl: `https://${id}.example/feed`,
      topicAnchors: ["photography"],
    }));
    const result = await collectDiscoveryFieldSignals({
      profile,
      now: new Date("2026-08-23T00:00:00.000Z"),
      existingUrls: new Set<string>(),
      sources: [
        ...earlySources,
        { id: "late", name: "Late Source", feedUrl: "https://late.example/feed", topicAnchors: ["photography"] },
      ],
      rss: async (url) => {
        if (url.includes("late")) {
          return {
            status: "OK" as const,
            errorCode: null,
            elapsedMs: 1,
            items: [{
              title: "Call for Papers: Photography and Visual Culture",
              url: "https://late.example/top",
              year: 2026,
              publishedAt: "2026-08-22T00:00:00.000Z",
              summary: "Photography and visual culture conference.",
            }],
          };
        }
        return {
          status: "OK" as const,
          errorCode: null,
          elapsedMs: 1,
          items: Array.from({ length: 4 }, (_, index) => ({
            title: `Photography Notice ${url} ${index}`,
            url: `${url}/${index}`,
            year: 2026,
            publishedAt: `2026-03-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
            summary: "Visual culture notice.",
          })),
        };
      },
    });

    expect(result.pending).toHaveLength(12);
    expect(result.pending[0]).toMatchObject({ sourceId: "late", externalUrl: "https://late.example/top" });
    expect(result.pending.filter((item) => item.sourceId === "late")).toHaveLength(1);
  });

  it("deduplicates incoming url and normalized title-date collisions in ranked order", async () => {
    const result = await collectDiscoveryFieldSignals({
      profile,
      now: new Date("2026-08-23T00:00:00.000Z"),
      existingUrls: new Set<string>(),
      sources: [
        { id: "earlier", name: "Earlier", feedUrl: "https://earlier.example/feed", topicAnchors: ["photography"] },
        { id: "winner", name: "Winner", feedUrl: "https://winner.example/feed", topicAnchors: ["photography"] },
        { id: "title-dupe", name: "Title Dupe", feedUrl: "https://title-dupe.example/feed", topicAnchors: ["photography"] },
      ],
      rss: async (url) => {
        if (url.includes("earlier")) {
          return {
            status: "OK" as const,
            errorCode: null,
            elapsedMs: 1,
            items: [{
              title: "Photography Notice",
              url: "https://signals.example/shared",
              year: 2026,
              publishedAt: "2026-03-01T00:00:00.000Z",
              summary: "Visual culture notice.",
            }],
          };
        }
        if (url.includes("winner")) {
          return {
            status: "OK" as const,
            errorCode: null,
            elapsedMs: 1,
            items: [{
              title: "Call for Papers: Photography and Visual Culture",
              url: "https://signals.example/shared",
              year: 2026,
              publishedAt: "2026-08-21T00:00:00.000Z",
              summary: "Photography and visual culture conference.",
            }],
          };
        }
        return {
          status: "OK" as const,
          errorCode: null,
          elapsedMs: 1,
          items: [{
            title: "Call for Papers - Photography and Visual Culture",
            url: "https://signals.example/other-url",
            year: 2026,
            publishedAt: "2026-08-21T00:00:00.000Z",
            summary: null,
          }],
        };
      },
    });

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({ sourceId: "winner", externalUrl: "https://signals.example/shared" });
    expect(result.diagnostics.sources.earlier).toMatchObject({ duplicate: 1, selected: 0 });
    expect(result.diagnostics.sources["title-dupe"]).toMatchObject({ duplicate: 1, selected: 0 });
    expect(result.diagnostics.sources.winner).toMatchObject({ duplicate: 0, selected: 1 });
    expect(result.diagnostics.rejectedByReason.DUPLICATE).toBe(2);
  });
});

describe("field signal persistence", () => {
  it("reports only inserted rows and turns ignored inserts into duplicate diagnostics", async () => {
    mockedFetchFeed.mockImplementation(async (url: string) => {
      if (!url.includes("collegeart")) return { status: "OK" as const, errorCode: null, elapsedMs: 1, items: [] };
      return {
        status: "OK" as const,
        errorCode: null,
        elapsedMs: 1,
        items: [
          {
            title: "Call for Papers: Photography and Visual Culture",
            url: "https://caa.example/cfp",
            year: 2026,
            publishedAt: "2026-08-22T00:00:00.000Z",
            summary: "Photography and visual culture conference.",
          },
          {
            title: "Photography Workshop",
            url: "https://caa.example/workshop",
            year: 2026,
            publishedAt: "2026-08-21T00:00:00.000Z",
            summary: "Photography and visual culture workshop.",
          },
        ],
      };
    });

    const env = createMockEnv([{ meta: { changes: 1 } }, { meta: { changes: 0 } }]);

    const result = await runDiscoveryFieldSignals(env, profile);

    expect(result.collected).toBe(1);
    expect(result.diagnostics.sources["caa-news"]).toMatchObject({
      selected: 1,
      duplicate: 1,
    });
    expect(result.diagnostics.rejectedByReason.DUPLICATE).toBe(1);
  });
});

function createMockEnv(batchResults: Array<{ meta?: { changes?: number } }>): Env {
  return {
    DB: {
      prepare(query: string): D1PreparedStatement {
        return {
          bind(): D1PreparedStatement {
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            if (query.includes("SELECT external_url FROM discovery_field_signals")) {
              return { results: [] };
            }
            return { results: [] };
          },
          async run() {
            return {};
          },
        };
      },
      async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
        return batchResults.slice(0, statements.length) as T[];
      },
    },
  };
}
