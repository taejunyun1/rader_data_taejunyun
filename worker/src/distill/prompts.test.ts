import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_VARIANT, distillPrompt, type PromptVariant } from "./prompts";
import type { DistillContext } from "./context";

const context: DistillContext = {
  keywords: [{ keyword: "사진", count: 2 }],
  questions: ["무엇이 보이는가"],
  sources: [{ id: "source-1", title: "자료", kind: "PAPER_ACADEMIC", year: 2024, summary: "요약", fragments: [], signals: [] }],
  recentKeepDevelop: [],
  params: { familiarity: 0.5, researchDepth: 0.5, divergence: 0.5, technicalPhotographic: 0.5, counterStrength: 0.5 },
};

describe("layered Distill prompt", () => {
  it("requests summary-indexed details from the source allowlist", () => {
    const variant: PromptVariant = "distill-v3-layered";
    const prompt = distillPrompt(context, variant);
    expect(DEFAULT_PROMPT_VARIANT).toBe(variant);
    expect(prompt).toContain('"details"');
    expect(prompt).toContain("summaryIndex");
    expect(prompt).toContain("SOURCE ID allowlist");
    expect(prompt).toContain("SYNTHESIS");
  });
});
