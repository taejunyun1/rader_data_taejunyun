import { describe, expect, it } from "vitest";
import { compositionRows, decisionRows, visibleSynthesisSections } from "./radarPresentation";

describe("radarPresentation", () => {
  it("keeps only human decision actions in a fixed order", () => {
    expect(decisionRows({ import: 8, view: 4, keep: 2, ignore: 1, develop: 3, watch: 0 })).toEqual([
      { action: "develop", label: "발전", count: 3, percent: 50 },
      { action: "keep", label: "보관", count: 2, percent: 33 },
      { action: "watch", label: "관찰", count: 0, percent: 0 },
      { action: "ignore", label: "제외", count: 1, percent: 17 },
    ]);
  });

  it("groups source kinds after the visible limit into 기타", () => {
    expect(compositionRows({ NOTE: 10, WEB: 8, PAPER_ACADEMIC: 4, PERSONAL_WORK: 2 }, 3)).toEqual([
      { kind: "NOTE", label: "메모", count: 10, percent: 42 },
      { kind: "WEB", label: "웹 자료", count: 8, percent: 33 },
      { kind: "OTHER", label: "기타", count: 6, percent: 25 },
    ]);
  });

  it("removes sections already owned by quantitative and question areas", () => {
    const sections = [
      { heading: "이번 주 새로 떠오른 키워드", items: ["사진"] },
      { heading: "반복해서 남은 질문", items: ["무엇을 읽을까"] },
      { heading: "멀리 있는 자료 사이의 새 연결", items: ["연결 A"] },
      { heading: "예상 밖의 자료", items: ["자료 B"] },
    ];
    expect(visibleSynthesisSections(sections)).toEqual([
      { heading: "멀리 있는 자료 사이의 새 연결", items: ["연결 A"] },
      { heading: "예상 밖의 자료", items: ["자료 B"] },
    ]);
  });
});
