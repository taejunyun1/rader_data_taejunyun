import { describe, expect, it } from "vitest";
import { evaluateDuplicate } from "./matching";

describe("evaluateDuplicate", () => {
  it("auto-merges the same normalized DOI", () => {
    expect(evaluateDuplicate(
      { doi: "https://doi.org/10.1/A" },
      { doi: "doi:10.1/a" },
    )).toMatchObject({
      decision: "AUTO_MERGE",
      reasons: ["DOI_EXACT"],
    });
  });

  it("reviews an exact normalized title without supporting evidence", () => {
    expect(evaluateDuplicate(
      { title: "Densecap Deepdream" },
      { title: "Densecap: Deepdream" },
    )).toMatchObject({
      decision: "REVIEW",
      reasons: ["TITLE_EXACT_WITHOUT_SUPPORT"],
      titleSimilarity: 1,
    });
  });

  it("separates conflicting nonempty DOIs", () => {
    expect(evaluateDuplicate(
      { doi: "10.1/a", canonicalUrl: "https://example.com/same" },
      { doi: "10.1/b", canonicalUrl: "https://example.com/same" },
    )).toMatchObject({
      decision: "SEPARATE",
      reasons: ["DOI_CONFLICT"],
    });
  });

  it.each([
    ["raw content hash", { rawContentHash: "raw-1" }, { rawContentHash: "raw-1" }, "RAW_HASH_EXACT"],
    ["normalized text hash", { normalizedTextHash: "text-1" }, { normalizedTextHash: "text-1" }, "NORMALIZED_TEXT_HASH_EXACT"],
  ])("lets an exact %s override a DOI conflict", (_label, left, right, reason) => {
    expect(evaluateDuplicate(
      { doi: "10.1/a", ...left },
      { doi: "10.1/b", ...right },
    )).toMatchObject({
      decision: "AUTO_MERGE",
      reasons: [reason],
    });
  });

  it.each([
    [
      "canonical URL",
      { canonicalUrl: "https://Example.com/paper/?utm_source=test" },
      { canonicalUrl: "https://example.com/paper" },
      "CANONICAL_URL_EXACT",
    ],
    [
      "normalized Obsidian origin",
      { origin: "obsidian:.worktrees/topic/10_PROJECTS/a.md" },
      { origin: "obsidian:10_PROJECTS/a.md" },
      "OBSIDIAN_ORIGIN_EXACT",
    ],
  ])("auto-merges the same %s", (_label, left, right, reason) => {
    expect(evaluateDuplicate(left, right)).toMatchObject({
      decision: "AUTO_MERGE",
      reasons: [reason],
    });
  });

  it.each([
    [{ authors: "Ada Example" }, { authors: "Ada Example" }, "FIRST_AUTHOR_EXACT"],
    [{ year: 2026 }, { year: 2026 }, "YEAR_EXACT"],
    [
      { canonicalUrl: "https://example.com/left" },
      { canonicalUrl: "https://example.com/right" },
      "CANONICAL_HOST_EXACT",
    ],
  ])("auto-merges a highly similar title with support", (leftSupport, rightSupport, reason) => {
    expect(evaluateDuplicate(
      { title: "abcdefghijklmnopqrstuvwxyz", ...leftSupport },
      { title: "abcdefghijklmnopqrstuvwxy0", ...rightSupport },
    )).toMatchObject({
      decision: "AUTO_MERGE",
      reasons: ["TITLE_SIMILAR_HIGH", reason],
    });
  });

  it("reviews title similarity at the lower threshold", () => {
    const assessment = evaluateDuplicate(
      { title: "abcdefgh" },
      { title: "abcdefgi" },
    );

    expect(assessment.decision).toBe("REVIEW");
    expect(assessment.reasons).toEqual(["TITLE_SIMILAR_REVIEW"]);
    expect(assessment.titleSimilarity).toBeCloseTo(6 / 7, 8);
  });

  it("separates titles below the review threshold", () => {
    expect(evaluateDuplicate(
      { title: "abcdefgh" },
      { title: "abcdxfgh" },
    )).toMatchObject({
      decision: "SEPARATE",
      reasons: ["TITLE_DISSIMILAR"],
    });
  });
});
