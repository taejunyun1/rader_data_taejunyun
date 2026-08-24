import { describe, expect, it } from "vitest";
import { formatSourceTitle } from "./sourcePresentation";

describe("formatSourceTitle", () => {
  it("removes CDATA and decoded markup", () => {
    expect(formatSourceTitle("&lt;![CDATA[At This Year's Rencontres d'Arles]]&gt;")).toBe("At This Year's Rencontres d'Arles");
  });

  it("turns filename-style slugs into readable titles", () => {
    expect(formatSourceTitle("2026-08-24-photo-paper-faithful-html-implementation")).toBe("photo paper faithful html implementation");
    expect(formatSourceTitle("automating_aesthetics")).toBe("automating aesthetics");
  });

  it("preserves meaningful hyphenated titles without filename signals", () => {
    expect(formatSourceTitle("Post-Photography")).toBe("Post-Photography");
  });

  it("preserves natural punctuation and supplies a fallback", () => {
    expect(formatSourceTitle("Photography & Automation — A Detailed Timeline")).toBe("Photography & Automation — A Detailed Timeline");
    expect(formatSourceTitle("   ")).toBe("제목 없음");
  });
});
