import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCOVERY_FEEDS,
  DEFAULT_FIELD_SIGNAL_FEEDS,
  DISCOVERY_SOURCE_PRESETS,
  discoverySourceByFeedUrl,
  discoverySourceById,
} from "@radar/shared";

describe("discovery source registry", () => {
  it("separates automatic reading feeds from field-signal feeds", () => {
    expect(DEFAULT_DISCOVERY_FEEDS).toEqual([
      "https://unthinking.photography/feed",
      "https://aperture.org/feed/",
      "https://hyperallergic.com/rss/",
      "https://lenscratch.com/feed/",
    ]);
    expect(DEFAULT_FIELD_SIGNAL_FEEDS).toEqual([
      "https://www.collegeart.org/news/feed/",
      "https://forarthistory.org.uk/feed/",
      "https://www.icp.org/rss.xml",
      "https://www.smb.museum/en/rss-feed/press-releases.xml",
    ]);
  });

  it("keeps stale, paywalled, and credentialed sources out of automatic collection", () => {
    const byId = new Map(DISCOVERY_SOURCE_PRESETS.map((source) => [source.id, source]));

    expect(byId.get("e-flux-journal")).toMatchObject({ collection: "SEARCH", autoCollect: false });
    expect(byId.get("e-flux-announcements")).toMatchObject({ target: "FIELD_SIGNAL", collection: "SEARCH", autoCollect: false });
    expect(byId.get("artforum")).toMatchObject({ target: "READING", accessPolicy: "PAYWALLED", autoCollect: false });
    expect(byId.get("artnews")).toMatchObject({ accessPolicy: "PAYWALLED", autoCollect: false });
    expect(byId.get("kci")).toMatchObject({ collection: "API", autoCollect: false });
    expect(byId.get("google-scholar")).toMatchObject({ collection: "SEARCH", autoCollect: false });
    expect(byId.get("lenscratch")).toMatchObject({ collection: "RSS", autoCollect: true, target: "READING" });
    expect(byId.get("smb-berlin")).toMatchObject({ collection: "RSS", autoCollect: true, target: "FIELD_SIGNAL" });
  });

  it("lists Korean academic web entry points without enabling implicit scraping", () => {
    const byId = new Map(DISCOVERY_SOURCE_PRESETS.map((source) => [source.id, source]));

    expect(byId.get("korean-photography-society-jams")).toMatchObject({
      url: "https://skp.jams.or.kr/",
      collection: "SEARCH",
      target: "READING",
      autoCollect: false,
    });
    expect(byId.get("kiss")).toMatchObject({ collection: "API", autoCollect: false });
    expect(byId.get("dbpia")).toMatchObject({ collection: "API", autoCollect: false });
    expect(byId.get("national-assembly-library")).toMatchObject({ collection: "API", autoCollect: false });
    expect(byId.get("scienceon")).toMatchObject({ collection: "API", autoCollect: false });
    expect(byId.get("arxiv")).toMatchObject({ collection: "API", autoCollect: false });
  });

  it("resolves a curated feed to its source policy", () => {
    expect(discoverySourceByFeedUrl("https://unthinking.photography/feed")).toMatchObject({
      id: "unthinking-photography",
      target: "READING",
      accessPolicy: "FREE_FULLTEXT",
    });
    expect(discoverySourceByFeedUrl("https://hyperallergic.com/feed/")).toMatchObject({
      id: "hyperallergic",
      feedUrl: "https://hyperallergic.com/rss/",
    });
    expect(discoverySourceByFeedUrl("https://unknown.example/feed")).toBeNull();
    expect(discoverySourceById("icp")).toMatchObject({ target: "FIELD_SIGNAL", autoCollect: true });
    expect(discoverySourceById("icp-news")).toBeNull();
    expect(discoverySourceById("unknown-source")).toBeNull();
  });
});
