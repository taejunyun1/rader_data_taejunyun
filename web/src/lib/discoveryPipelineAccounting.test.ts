import { describe, expect, it } from "vitest";
import {
  collectDiscoveryCandidates,
  resolveDiscoveryReadingFeeds,
  sanitizeCustomFeedUrls,
} from "../../../worker/src/discovery/run";
import { selectDiscoveryCandidatesByLane } from "@radar/shared/discovery";

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

  it("accepts a verified free HTML feed and keeps its source provenance", async () => {
    const result = await collectDiscoveryCandidates({
      profile: {
        original: { keywords: ["photography"], strength: 70 },
        counter: { keywords: [], strength: 0 },
        updatedAt: "2026-08-23T00:00:00.000Z",
      },
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
      feeds: [{
        sourceId: "unthinking-photography",
        feedUrl: "https://unthinking.photography/feed",
        accessPolicy: "FREE_FULLTEXT",
      }],
      existingExternalIds: new Set<string>(),
      activeTitles: new Set<string>(),
      divergence: 0,
      clients: {
        openalex: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
        arxiv: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
        rss: async () => ({
          status: "OK" as const,
          items: [{
            title: "Machine Readable Photography and Visual Culture",
            url: "https://unthinking.photography/articles/machine-readable-photography",
            year: 2026,
            publishedAt: "2026-08-18T00:00:00.000Z",
            summary: "Photography, machine vision, authorship, and network culture.",
          }],
          errorCode: null,
          elapsedMs: 0,
        }),
      },
    });

    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toMatchObject({
      sourceId: "unthinking-photography",
      accessStatus: "FREE_FULLTEXT",
      provider: "rss",
    });
  });

  it("rejects custom RSS HTML when the feed policy stays unknown even if the URL looks free", async () => {
    const result = await collectDiscoveryCandidates({
      profile: {
        original: { keywords: ["photography"], strength: 70 },
        counter: { keywords: [], strength: 0 },
        updatedAt: "2026-08-23T00:00:00.000Z",
      },
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
      feeds: [{
        sourceId: "custom:https://custom.example/feed.xml",
        feedUrl: "https://custom.example/feed.xml",
        accessPolicy: "UNKNOWN",
      }],
      existingExternalIds: new Set<string>(),
      activeTitles: new Set<string>(),
      divergence: 0,
      clients: {
        openalex: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
        arxiv: async () => ({ status: "OK" as const, items: [], errorCode: null, elapsedMs: 0 }),
        rss: async () => ({
          status: "OK" as const,
          items: [{
            title: "Machine Readable Photography and Visual Culture",
            url: "https://hyperallergic.com/example/custom-feed-story/",
            year: 2026,
            publishedAt: "2026-08-18T00:00:00.000Z",
            summary: "Photography, machine vision, authorship, and network culture.",
          }],
          errorCode: null,
          elapsedMs: 0,
        }),
      },
    });

    expect(result.pending).toHaveLength(0);
    expect(result.diagnostics.providers.rss).toMatchObject({
      received: 1,
      missingAccess: 1,
      selected: 0,
    });
  });

  it("always merges current curated feeds and removes legacy curated KV values", () => {
    const feeds = resolveDiscoveryReadingFeeds([
      "https://www.artforum.com/feed",
      "https://hyperallergic.com/feed/",
      "https://custom.example/photo-feed.xml",
    ]);

    expect(feeds.map((feed) => feed.feedUrl)).toEqual([
      "https://unthinking.photography/feed",
      "https://aperture.org/feed/",
      "https://hyperallergic.com/rss/",
      "https://custom.example/photo-feed.xml",
    ]);
    expect(feeds.at(-1)).toMatchObject({
      sourceId: "custom:https://custom.example/photo-feed.xml",
      accessPolicy: "UNKNOWN",
    });
  });

  it("keeps only public custom HTTP feeds while preserving curated-feed removal and the six-feed cap", () => {
    expect(sanitizeCustomFeedUrls([
      "https://custom.example/feed.xml",
      "http://127.0.0.1/feed",
      "http://[::1]/feed",
      "https://localhost/feed",
      "ftp://custom.example/feed.xml",
      "not a url",
      "https://unthinking.photography/feed",
      "https://custom.example/feed-2.xml",
      "https://custom.example/feed-3.xml",
      "https://custom.example/feed-4.xml",
      "https://custom.example/feed-5.xml",
      "https://custom.example/feed-6.xml",
      "https://custom.example/feed-7.xml",
    ])).toEqual([
      "https://custom.example/feed.xml",
      "https://custom.example/feed-2.xml",
      "https://custom.example/feed-3.xml",
      "https://custom.example/feed-4.xml",
      "https://custom.example/feed-5.xml",
      "https://custom.example/feed-6.xml",
    ]);
  });

  it("balances RSS picks by source before taking a second item from the same feed", () => {
    const selected = selectDiscoveryCandidatesByLane([
      { externalId: "rss-1", provider: "rss", sourceId: "feed-a", title: "Photography and Visual Culture", score: 0.91, lane: "ORIGINAL", querySource: "FEED" },
      { externalId: "rss-2", provider: "rss", sourceId: "feed-a", title: "Materiality and Tactility in Photography", score: 0.9, lane: "ORIGINAL", querySource: "FEED" },
      { externalId: "rss-3", provider: "rss", sourceId: "feed-b", title: "Machine Vision and Authorship", score: 0.89, lane: "ORIGINAL", querySource: "FEED" },
      { externalId: "oa-1", provider: "openalex", title: "OpenAlex One", score: 0.95, lane: "ORIGINAL", querySource: "SAVED" },
      { externalId: "oa-2", provider: "openalex", title: "OpenAlex Two", score: 0.94, lane: "ORIGINAL", querySource: "SAVED" },
    ], 100, 0, 0, 4);

    expect(selected.map((item) => item.externalId)).toEqual(["oa-1", "oa-2", "rss-1", "rss-3"]);
  });
});
