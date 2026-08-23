import { describe, expect, it } from "vitest";
import {
  assessDiscoveryFieldSignal,
  classifyDiscoveryFieldSignalType,
  extractDiscoveryFieldSignalDates,
} from "@radar/shared/fieldSignals";

const profile = {
  original: { keywords: ["photography", "machine vision"], strength: 70 },
  counter: { keywords: ["현장 선택과 사진적 증언"], strength: 30 },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("field signal classification", () => {
  it.each([
    ["Call for Papers: Photography and Machine Vision", "CALL_FOR_PAPERS"],
    ["Annual Conference on Visual Culture", "CONFERENCE"],
    ["Open Call for a Photography Residency", "RESIDENCY"],
    ["Grant and Fellowship Opportunities", "GRANT"],
    ["New Exhibition: Networked Images", "EXHIBITION"],
    ["Photography Workshop", "WORKSHOP"],
  ] as const)("classifies %s", (title, expected) => {
    expect(classifyDiscoveryFieldSignalType(title)).toBe(expected);
  });

  it("extracts only explicit event and deadline dates", () => {
    expect(extractDiscoveryFieldSignalDates(
      "Conference on September 12, 2026. Apply by 2026-08-31.",
      2026,
    )).toEqual({
      eventAt: "2026-09-12T00:00:00.000Z",
      deadlineAt: "2026-08-31T00:00:00.000Z",
    });
    expect(extractDiscoveryFieldSignalDates("Join us next autumn", 2026)).toEqual({ eventAt: null, deadlineAt: null });
  });
});

describe("field signal relevance", () => {
  it("accepts a recent photography CFP from a trusted academic source", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Call for Papers: Photography, AI, and Visual Culture",
      summary: "A conference on machine vision, authorship, and image politics.",
      publishedAt: "2026-08-10T00:00:00.000Z",
      profile,
      sourceAnchors: ["visual arts", "art history"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: true, signalType: "CALL_FOR_PAPERS" });
  });

  it("rejects stale signals without inventing a deadline", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Photography Conference",
      summary: "Visual culture conference.",
      publishedAt: "2024-01-01T00:00:00.000Z",
      profile,
      sourceAnchors: ["photography"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "STALE", eventAt: null, deadlineAt: null });
  });

  it("rejects an expired deadline even when the post is recent", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Call for Papers: Photography Conference",
      summary: "Deadline 2026-08-20.",
      publishedAt: "2026-08-18T00:00:00.000Z",
      profile,
      sourceAnchors: ["photography"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "EXPIRED", deadlineAt: "2026-08-20T00:00:00.000Z" });
  });

  it("does not trust a source anchor unless the item text matches it", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Call for Papers: Agricultural Trade",
      summary: "A conference about crop exports.",
      publishedAt: "2026-08-20T00:00:00.000Z",
      profile,
      sourceAnchors: ["photography", "visual culture"],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "NO_RESEARCH_MATCH" });
  });

  it("rejects generic institution news with no research match", () => {
    expect(assessDiscoveryFieldSignal({
      title: "Office Holiday Hours Updated",
      summary: "The office will close early on Friday.",
      publishedAt: "2026-08-20T00:00:00.000Z",
      profile,
      sourceAnchors: [],
      now: new Date("2026-08-23T00:00:00.000Z"),
    })).toMatchObject({ accepted: false, reason: "NO_RESEARCH_MATCH" });
  });
});
