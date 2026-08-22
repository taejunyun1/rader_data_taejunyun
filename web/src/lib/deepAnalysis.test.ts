import { describe, expect, it } from "vitest";
import { chunkText, keepVerbatimQuotes, validateDeepPayload } from "../../../worker/src/analysis/deepPrompt";

describe("deep analysis core", () => {
  it("splits a long source at paragraph boundaries and keeps a bounded number of chunks", () => {
    const text = Array.from({ length: 5 }, (_, index) => `문단 ${index} ` + "내용 ".repeat(5000)).join("\n\n");
    const chunks = chunkText(text, 24000, 4);
    expect(chunks).toHaveLength(4);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });

  it("removes synthesized quotes that do not exist in the source", () => {
    const payload = validateDeepPayload({ overview: "요약", quotes: ["실제 문장", "만들어진 문장"] }, "precision", 20, 20, 1)!;
    const result = keepVerbatimQuotes(payload, "앞 문장\n실제 문장\n뒤 문장");
    expect(result.quotes).toEqual(["실제 문장"]);
  });
});
