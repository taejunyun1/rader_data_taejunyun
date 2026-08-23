import { describe, expect, it } from "vitest";
import { buildDiscoveryQueryPlan } from "../../../worker/src/discovery/queryPlan";

const profile = {
  original: {
    keywords: ["AI/알고리즘", "네트워크-이미지", "데이터", "사진의 재현"],
    strength: 10,
  },
  counter: {
    keywords: [
      "기술 변수의 효과가 해석적으로 무의미하거나 불안정함을 블라인드 비교로 검증하기",
      "기술 조건의 엄격한 통제와 현장 선택의 우선성",
      "느린 재방문과 제한된 맥락 안의 사진적 증언",
      "수용·사용·증언의 사건을 이미지 의미의 주된 설명 단위로 삼기",
    ],
    strength: 90,
  },
  updatedAt: "2026-08-23T00:00:00.000Z",
};

describe("buildDiscoveryQueryPlan", () => {
  it("keeps provenance but sends provider-friendly queries", () => {
    const plan = buildDiscoveryQueryPlan({
      profile,
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
    });

    const original = plan.find((item) => item.sourceQuery === "AI/알고리즘");
    const counter = plan.find((item) => item.sourceQuery.startsWith("기술 변수의 효과"));

    expect(original).toMatchObject({
      providerQuery: "AI algorithm visual culture",
      lane: "ORIGINAL",
      selected: true,
      status: "READY",
    });
    expect(counter?.providerQuery).toBe("visual culture comparison technical variables");
    expect(counter?.providerQuery).not.toContain("기술 변수의 효과");
  });

  it("uses one original query and at most four counter queries at 10:90", () => {
    const plan = buildDiscoveryQueryPlan({
      profile,
      homepageKeywords: [],
      momentumKeywords: [],
      legacyQueries: [],
    });

    expect(plan.filter((item) => item.selected && item.lane === "ORIGINAL")).toHaveLength(1);
    expect(plan.filter((item) => item.selected && item.lane === "COUNTER")).toHaveLength(4);
  });
});
