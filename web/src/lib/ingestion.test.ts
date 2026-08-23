import { describe, expect, it } from "vitest";
import {
  classifyTextScope,
  deriveIngestMeta,
  normalizeIngestText,
  type InputFormat,
} from "@radar/shared/ingestion";

describe("ingestion normalization", () => {
  it("normalizes Obsidian links and keeps headings and code blocks", () => {
    const result = normalizeIngestText(
      "---\ntags: [photo]\n---\n# 제목\n[[작업노트|표시명]]\n![[image.png]]\n```js\nconst x = 1\n```",
      "OBSIDIAN_MARKDOWN",
    );

    expect(result.normalizedText).toContain("# 제목");
    expect(result.normalizedText).toContain("표시명");
    expect(result.normalizedText).toContain("[첨부: image.png]");
    expect(result.normalizedText).toContain("const x = 1");
    expect(result.report.unresolvedEmbedCount).toBe(1);
  });

  it("uses a shorter readiness threshold for personal notes", () => {
    expect(normalizeIngestText("사진의 표면과 데이터의 물질성을 연결해 다음 작업의 방향을 생각해 본 짧은 연구 메모입니다. 다음 관찰을 이어서 기록합니다.", "PLAIN_TEXT").qualityStatus).toBe("READY");
    expect(normalizeIngestText("짧음", "PDF_TEXT").qualityStatus).toBe("REVIEW");
  });

  it.each([
    ["obsidian:10_PROJECTS/note.md", "note.md", undefined, "OBSIDIAN", "OBSIDIAN_MARKDOWN"],
    ["upload:pdf", "paper.pdf", { scannedPdf: true }, "MANUAL", "PDF_SCAN"],
    ["url", undefined, undefined, "MANUAL", "URL_HTML"],
    ["discovery:arxiv", undefined, undefined, "DISCOVERY", "DISCOVERY_LINK"],
  ] satisfies Array<[string, string | undefined, Record<string, unknown> | undefined, string, InputFormat]>)
    ("derives %s as %s", (origin, filename, metadata, channel, format) => {
      expect(deriveIngestMeta(origin, filename, metadata)).toEqual({ channel, format });
    });

  it("accepts a long clean remote HTML article as full text", () => {
    const result = classifyTextScope({
      format: "URL_HTML",
      meaningfulChars: 2_400,
      warnings: [],
      extractionMethod: "HTML_STATIC",
    });

    expect(result).toEqual({ scope: "FULLTEXT", qualityStatus: "READY" });
  });

  it("does not treat a discovery title as analysable text", () => {
    const result = classifyTextScope({
      format: "DISCOVERY_LINK",
      meaningfulChars: 92,
      warnings: [],
      extractionMethod: "DISCOVERY_METADATA",
    });

    expect(result).toEqual({ scope: "METADATA_ONLY", qualityStatus: "REVIEW" });
  });

  it("marks a PDF conversion with no text as empty", () => {
    const result = classifyTextScope({
      format: "PDF_TEXT",
      meaningfulChars: 0,
      warnings: ["empty_text"],
      extractionMethod: "PDF_REMOTE_TO_MARKDOWN",
    });

    expect(result).toEqual({ scope: "EMPTY", qualityStatus: "EMPTY" });
  });
});
