import { describe, expect, it } from "vitest";
import {
  allocateDiscoveryLaneQuotas,
  normalizeDiscoveryProfile,
  strengthFetchLimit,
  strengthQueryLimit,
} from "@radar/shared/discovery";

describe("discovery profile", () => {
  it("normalizes duplicate keywords and clamps strengths", () => {
    expect(normalizeDiscoveryProfile({
      original: { keywords: [" 사진 이론 ", "사진 이론", "data", "시각문화"], strength: 104 },
      counter: { keywords: ["물질성 비판"], strength: -3 },
    }, "2026-08-22T00:00:00.000Z")).toEqual({
      original: { keywords: ["사진 이론", "시각문화"], strength: 100 },
      counter: { keywords: ["물질성 비판"], strength: 0 },
      updatedAt: "2026-08-22T00:00:00.000Z",
    });
  });

  it.each([
    [0, 0, 0],
    [20, 1, 2],
    [50, 2, 4],
    [80, 4, 6],
  ])("maps strength %i to query and fetch limits", (strength, queries, fetches) => {
    expect(strengthQueryLimit(strength)).toBe(queries);
    expect(strengthFetchLimit(strength)).toBe(fetches);
  });

  it("allocates 70:30 into six and two final slots", () => {
    expect(allocateDiscoveryLaneQuotas(70, 30, 8)).toEqual({ ORIGINAL: 6, COUNTER: 2 });
  });

  it("guarantees one slot to each active lane", () => {
    expect(allocateDiscoveryLaneQuotas(99, 1, 8)).toEqual({ ORIGINAL: 7, COUNTER: 1 });
  });
});
