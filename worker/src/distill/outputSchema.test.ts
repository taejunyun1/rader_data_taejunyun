import { describe, expect, it } from "vitest";
import { parseCriticOutput, parseDistillOutput, sanitizeDistillDetails, type DistillOutput } from "./outputSchema";

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

  it("accepts and sanitizes optional layered details against summary and source bounds", () => {
    const layered = {
      ...validDistill,
      details: {
        thoughts: [{ summaryIndex: 0, rationale: "판단 이유", sourceIds: ["source-1", "unknown"], uncertainty: "불확실", nextCheck: "확인" }],
        questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
      },
    };
    const parsed = parseDistillOutput(layered);
    const thought = layered.details.thoughts[0]!;
    expect(parsed).toEqual(layered);
    expect(sanitizeDistillDetails(parsed!, new Set(["source-1"])).details?.thoughts[0]?.sourceIds).toEqual(["source-1"]);
    expect(sanitizeDistillDetails({ ...layered, details: { ...layered.details, thoughts: [
      thought,
      { ...thought, rationale: "duplicate" },
    ] } }, new Set(["source-1"])).details?.thoughts).toHaveLength(1);
  });

  it("preserves a valid summary when the optional details object is malformed", () => {
    const malformed = {
      ...validDistill,
      details: {
        thoughts: [{ summaryIndex: 0, rationale: 42, sourceIds: [], uncertainty: "불확실", nextCheck: "확인" }],
        questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
      },
    };

    const parsed = parseDistillOutput(malformed);

    expect(parsed).not.toBeNull();
    expect(parsed?.thoughts_fragments).toEqual(validDistill.thoughts_fragments);
    expect(parsed?.details).toBeUndefined();
  });

  it("drops blank detail items while preserving non-empty items", () => {
    const parsed = parseDistillOutput({
      ...validDistill,
      details: {
        thoughts: [
          { summaryIndex: 0, rationale: "   ", sourceIds: [], uncertainty: "   ", nextCheck: "   " },
          { summaryIndex: 0, rationale: "  근거  ", sourceIds: [" source-1 ", "unknown"], uncertainty: " 불확실 ", nextCheck: " 다음 확인 " },
        ],
        questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
      },
    });

    const sanitized = sanitizeDistillDetails(parsed!, new Set(["source-1"]));

    expect(sanitized.details?.thoughts).toEqual([{
      summaryIndex: 0,
      rationale: "근거",
      sourceIds: ["source-1"],
      uncertainty: "불확실",
      nextCheck: "다음 확인",
    }]);
  });

  it("lets a valid duplicate-index item survive an invalid earlier item", () => {
    const parsed = parseDistillOutput({
      ...validDistill,
      details: {
        thoughts: [
          { summaryIndex: 0, rationale: "", sourceIds: [], uncertainty: "", nextCheck: "" },
          { summaryIndex: 0, rationale: "유효한 근거", sourceIds: [], uncertainty: "불확실", nextCheck: "다음 확인" },
        ],
        questions: [], researchGaps: [], researchDirections: [], artworkDirections: [],
      },
    });

    const sanitized = sanitizeDistillDetails(parsed!, new Set());

    expect(sanitized.details?.thoughts).toEqual([{
      summaryIndex: 0,
      rationale: "유효한 근거",
      sourceIds: [],
      uncertainty: "불확실",
      nextCheck: "다음 확인",
    }]);
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
