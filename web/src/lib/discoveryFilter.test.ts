import { describe, expect, it } from "vitest";
import {
  assessDiscoveryCandidate,
  classifyDiscoveryAccess,
  cleanDiscoverySourceText,
  isUsableDiscoveryQuery,
  normalizeDiscoveryTitle,
  resolveDiscoveryAccessForExisting,
  selectDiscoveryCandidates,
} from "@radar/shared/discovery";

describe("discovery filtering", () => {
  it("normalizes title entities and punctuation before deduplication", () => {
    expect(normalizeDiscoveryTitle("<![CDATA[Image Processing, Analysis &amp; Machine Vision]]>")).toBe(
      "image processing analysis machine vision",
    );
  });

  it("accepts a recent photography paper with a readable PDF", () => {
    const result = assessDiscoveryCandidate({
      provider: "arxiv",
      title: "Mobile Computational Photography: A Tour",
      year: 2021,
      accessStatus: "PDF",
    });

    expect(result.accepted).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.65);
  });

  it("rejects generic theory papers from unrelated physics domains", () => {
    const result = assessDiscoveryCandidate({
      provider: "arxiv",
      title: "Variational Approach to Quantum Field Theory: Gaussian Approximation",
      year: 1997,
      accessStatus: "PDF",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("BLOCKED_DOMAIN");
  });

  it("rejects generic museum news even when the page is readable", () => {
    const result = assessDiscoveryCandidate({
      provider: "rss",
      title: "National Gallery of Art Adds a Slew of New Artists to Its Collection",
      summary: "The museum announced a new group of acquisitions.",
      year: 2026,
      accessStatus: "FREE_FULLTEXT",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("NO_RESEARCH_ANCHOR");
  });

  it("keeps paywalled articles out even when their topic is relevant", () => {
    const result = assessDiscoveryCandidate({
      provider: "rss",
      title: "Visitors Encounter Digital Artwork and Wrongly Brand It AI Slop",
      summary: "The incident raises questions about machine vision, authorship, and visual culture.",
      year: 2026,
      accessStatus: "PAYWALLED",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("PAYWALLED");
  });

  it.each(["UNKNOWN", "INSTITUTION"] as const)("rejects candidates without directly readable access: %s", (accessStatus) => {
    const result = assessDiscoveryCandidate({
      provider: "openalex",
      title: "Photography and the Politics of the Image",
      year: 2025,
      accessStatus,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("ACCESS_UNKNOWN");
  });

  it.each([
    "Image Processing, Analysis and Machine Vision",
    "Camera Calibration for High-Accuracy 3D Machine Vision Metrology",
    "Photozilla: A Dataset for Image Retrieval",
    "EarthMatch: Geolocating Astronaut Photography with Vision Transformers",
  ])("rejects engineering-only discovery candidates: %s", (title) => {
    const result = assessDiscoveryCandidate({
      provider: "openalex",
      title,
      summary: "A benchmark and system evaluation for an automated computer vision pipeline.",
      year: 2025,
      accessStatus: "FREE_FULLTEXT",
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("ENGINEERING_ONLY");
  });

  it.each([
    "Photography and the Politics of the Image",
    "Materiality, Tactility, and Print Labor in Contemporary Photography",
    "Machine Vision, Visual Culture, and Algorithmic Bias",
    "Digital Labor and the Social Life of Images",
  ])("accepts critical photography and visual-culture candidates: %s", (title) => {
    const result = assessDiscoveryCandidate({
      provider: "arxiv",
      title,
      summary: "This paper examines image politics, cultural context, authorship, and embodied practice.",
      year: 2025,
      accessStatus: "PDF",
    });

    expect(result.accepted).toBe(true);
    expect(result.reason).toBe("RELEVANT");
  });
});

describe("discovery access classification", () => {
  it("does not describe known publisher pages as free original links", () => {
    expect(classifyDiscoveryAccess("rss", "https://www.artnews.com/art-news/example/")).toBe("PAYWALLED");
    expect(classifyDiscoveryAccess("rss", "https://www.artforum.com/news/example/")).toBe("PAYWALLED");
  });

  it("marks arXiv and Hyperallergic links as readable", () => {
    expect(classifyDiscoveryAccess("arxiv", "https://arxiv.org/abs/2102.09000")).toBe("PDF");
    expect(classifyDiscoveryAccess("rss", "https://hyperallergic.com/example/")).toBe("FREE_FULLTEXT");
  });

  it("preserves stored OpenAlex free-fulltext evidence during re-evaluation", () => {
    expect(resolveDiscoveryAccessForExisting("FREE_FULLTEXT", "openalex", "https://repository.example/item")).toBe("FREE_FULLTEXT");
  });

  it("trusts free HTML only when the curated source policy verifies it", () => {
    expect(classifyDiscoveryAccess(
      "rss",
      "https://unthinking.photography/articles/machine-readable-photography",
      "FREE_FULLTEXT",
    )).toBe("FREE_FULLTEXT");
    expect(classifyDiscoveryAccess(
      "rss",
      "https://unknown.example/articles/photography",
    )).toBe("UNKNOWN");
  });

  it("keeps a curated paywalled policy stronger than a generic RSS provider", () => {
    expect(classifyDiscoveryAccess(
      "rss",
      "https://www.artforum.com/features/example",
      "PAYWALLED",
    )).toBe("PAYWALLED");
  });
});

describe("discovery query seeds", () => {
  it("does not use generic words as standalone search seeds", () => {
    expect(isUsableDiscoveryQuery("data")).toBe(false);
    expect(isUsableDiscoveryQuery("theory")).toBe(false);
    expect(isUsableDiscoveryQuery("AI")).toBe(false);
    expect(isUsableDiscoveryQuery("machine vision photography")).toBe(true);
    expect(isUsableDiscoveryQuery("network-culture")).toBe(true);
  });
});

describe("discovery candidate selection", () => {
  it("deduplicates titles, caps each provider, and returns at most eight candidates", () => {
    const items = [
      ...Array.from({ length: 6 }, (_, index) => ({ externalId: `oa-${index}`, provider: "openalex", title: `OpenAlex ${index}`, score: 0.9 - index / 100 })),
      { externalId: "oa-duplicate", provider: "openalex", title: "OpenAlex 0", score: 0.99 },
      ...Array.from({ length: 3 }, (_, index) => ({ externalId: `ax-${index}`, provider: "arxiv", title: `arXiv ${index}`, score: 0.8 - index / 100 })),
      ...Array.from({ length: 3 }, (_, index) => ({ externalId: `rss-${index}`, provider: "rss", title: `RSS ${index}`, score: 0.7 - index / 100 })),
    ];

    const selected = selectDiscoveryCandidates(items, 0.2);

    expect(selected).toHaveLength(8);
    expect(selected.filter((item) => item.provider === "openalex")).toHaveLength(4);
    expect(selected.filter((item) => item.provider === "arxiv")).toHaveLength(2);
    expect(selected.filter((item) => item.provider === "rss")).toHaveLength(2);
    expect(new Set(selected.map((item) => normalizeDiscoveryTitle(item.title))).size).toBe(selected.length);
  });
});

describe("discovery source text", () => {
  it("cleans RSS CDATA, entities, and markup", () => {
    expect(cleanDiscoverySourceText("<![CDATA[An&nbsp;image &#160; &amp; <b>labor</b>]]>")).toBe("An image & labor");
  });
});
