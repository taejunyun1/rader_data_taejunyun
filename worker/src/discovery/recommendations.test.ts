import { describe, expect, it } from "vitest";
import { diversifyRecommendations, type CandidateRecommendation } from "./recommendations";

describe("diversifyRecommendations", () => {
  it("keeps the best normalized keyword and round-robins source categories", () => {
    const items: CandidateRecommendation[] = [
      { keyword: "저장 키워드", lane: "ORIGINAL", source: "SAVED", score: 1, reason: "저장" },
      { keyword: "최근 흐름", lane: "ORIGINAL", source: "MOMENTUM", score: 0.8, reason: "흐름" },
      { keyword: "착즙 키워드", lane: "ORIGINAL", source: "DISTILL", score: 0.9, reason: "착즙" },
      { keyword: "연구 공백", lane: "ORIGINAL", source: "RESEARCH_GAP", score: 0.7, reason: "공백" },
      { keyword: "저장 추가", lane: "ORIGINAL", source: "SAVED", score: 0.6, reason: "저장" },
      { keyword: "중복 주제", lane: "ORIGINAL", source: "SAVED", score: 0.2, reason: "낮은 점수" },
      { keyword: "중복   주제", lane: "ORIGINAL", source: "MOMENTUM", score: 0.95, reason: "높은 점수" },
      { keyword: "흐름 추가", lane: "ORIGINAL", source: "MOMENTUM", score: 0.5, reason: "흐름" },
    ];

    const recommendations = diversifyRecommendations(items, ["저장 키워드"]);

    expect(recommendations.slice(0, 4).map(({ source }) => source)).toEqual(["SAVED", "MOMENTUM", "DISTILL", "RESEARCH_GAP"]);
    expect(recommendations).toHaveLength(7);
    expect(recommendations.find(({ keyword }) => keyword === "중복   주제")).toMatchObject({
      source: "MOMENTUM",
      score: 0.95,
      reason: "높은 점수",
    });
    expect(recommendations.find(({ keyword }) => keyword === "저장 키워드")).toMatchObject({ selected: true });
  });
});
