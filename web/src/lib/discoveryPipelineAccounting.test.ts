import { describe, expect, it } from "vitest";
import { collectDiscoveryCandidates } from "../../../worker/src/discovery/run";

describe("discovery pipeline accounting", () => {
  it("counts access, quality, duplicate, quota, and selected outcomes without overlap", async () => {
    const result = await collectDiscoveryCandidates({
      profile: {
        original: { keywords: ["photography"], strength: 70 },
        counter: { keywords: [], strength: 0 },
        updatedAt: "2026-08-23T00:00:00.000Z",
      },
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
      feeds: [],
      existingExternalIds: new Set(["duplicate"]),
      activeTitles: new Set<string>(),
      divergence: 0,
      clients: {
        openalex: async () => ({
          status: "OK" as const,
          items: [
            { id: "no-access", title: "Photography", authors: "", year: 2025, abstract: null, doi: null, openAccessUrl: null, citedByCount: 0 },
            { id: "low-quality", title: "Unrelated", authors: "", year: 2025, abstract: null, doi: null, openAccessUrl: "https://repository.example/low-quality", citedByCount: 0 },
            { id: "duplicate", title: "Photography and the Politics of the Image", authors: "", year: 2025, abstract: "image politics and authorship", doi: null, openAccessUrl: "https://repository.example/duplicate", citedByCount: 0 },
            { id: "selected", title: "Materiality, Tactility, and Print Labor in Contemporary Photography", authors: "", year: 2025, abstract: "materiality, tactility, and print labor", doi: null, openAccessUrl: "https://repository.example/selected", citedByCount: 0 },
          ],
          errorCode: null,
          elapsedMs: 0,
        }),
        arxiv: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
        rss: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
      },
    });

    expect(result.diagnostics.providers.openalex).toMatchObject({
      received: 4,
      missingAccess: 1,
      rejected: 1,
      duplicate: 1,
      selected: 1,
    });
  });
});
