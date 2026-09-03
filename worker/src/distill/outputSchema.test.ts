import { describe, expect, it } from "vitest";
import { parseCriticOutput, parseDistillOutput, type DistillOutput } from "./outputSchema";

const validDistill: DistillOutput = {
  keywords: ["빛"], thoughts_fragments: ["관찰"], questions: ["무엇이 보이는가"],
  research_directions: ["현상학"], artwork_directions: ["인화"],
  read_next: [{ title: "Camera Lucida", author: "Roland Barthes", why_read: "사진의 지시성", related_question: "무엇이 보이는가" }],
  research_gaps: [{ gap: "근거 부족", kind: "under-evidenced" }], small_experiment: "한 장 촬영",
};

describe("strict Distill output", () => {
  it("requires every array and nested member", () => {
    expect(parseDistillOutput({ keywords: [], research_directions: [] })).toBeNull();
    expect(parseDistillOutput(validDistill)).toEqual(validDistill);
    expect(parseDistillOutput({ ...validDistill, questions: [42] })).toBeNull();
    expect(parseDistillOutput({ ...validDistill, read_next: [{ title: "x", why_read: 1 }] })).toBeNull();
    expect(parseDistillOutput({ ...validDistill, research_gaps: [{ gap: "x" }] })).toBeNull();
    expect(parseDistillOutput({ ...validDistill, small_experiment: 42 })).toBeNull();
  });

  it("rejects malformed stored JSON and the historical weak shape", () => {
    expect(parseDistillOutput("{\"keywords\":[\"x\"]" )).toBeNull();
    expect(parseDistillOutput({ keywords: [], research_directions: [] })).toBeNull();
  });

  it("strictly validates critic output", () => {
    expect(parseCriticOutput({ warnings: [], overall: "sound" })).toEqual({ warnings: [], overall: "sound" });
    expect(parseCriticOutput({ warnings: [{ category: "x", note: "y" }], overall: "sound" })).toEqual({ warnings: [{ category: "x", note: "y" }], overall: "sound" });
    expect(parseCriticOutput({ warnings: [{ category: "x" }], overall: "sound" })).toBeNull();
  });
});
