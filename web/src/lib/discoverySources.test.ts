import { describe, expect, it } from "vitest";
import { DEFAULT_DISCOVERY_FEEDS, DISCOVERY_SOURCE_PRESETS } from "@radar/shared";

describe("discovery source registry", () => {
  it("includes the requested academic and art research entry points", () => {
    const ids = new Set(DISCOVERY_SOURCE_PRESETS.map((source) => source.id));

    expect([...ids]).toEqual(expect.arrayContaining([
      "e-flux-journal",
      "e-flux-announcements",
      "riss",
      "google-scholar",
      "scopus",
      "web-of-science",
      "aperture",
      "caa-news",
      "getty-news",
      "icp-news",
      "moma-research",
    ]));
  });

  it("only treats public feeds as automatic collection sources", () => {
    expect(DEFAULT_DISCOVERY_FEEDS).toContain("https://aperture.org/feed/");
    expect(DEFAULT_DISCOVERY_FEEDS).not.toContain("https://www.riss.kr/");
    expect(DISCOVERY_SOURCE_PRESETS.find((source) => source.id === "riss")?.collection).toBe("API");
    expect(DISCOVERY_SOURCE_PRESETS.find((source) => source.id === "google-scholar")?.collection).toBe("SEARCH");
  });
});
