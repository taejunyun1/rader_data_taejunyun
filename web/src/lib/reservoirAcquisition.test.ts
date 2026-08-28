import { describe, expect, it } from "vitest";
import reservoir from "../../../worker/src/routes/reservoir";
import type { PdfVisualExtractionCapability } from "@radar/shared";

interface AcquisitionRow {
  acquisitionTextScope: string | null;
  acquisitionExtractionMethod: string | null;
  acquisitionQualityStatus: string | null;
  acquisitionCharCount: number | null;
  acquisitionError: string | null;
  acquisitionOriginalR2Key?: string | null;
  normalizedText: string | null;
  extractedText: string | null;
}

function detailDb(acquisition: AcquisitionRow): D1Database {
  const { normalizedText, extractedText, acquisitionOriginalR2Key, ...acquisitionColumns } = acquisition;
  const source = {
    id: "source-1",
    kind: "WEB",
    title: "자료",
    authors: "저자",
    year: 2026,
    canonicalUrl: "https://example.com/article",
    doi: null,
    reliability: "DISCOVERY",
    provenanceClass: "SOURCE",
    status: "analyzed",
    origin: "DISCOVERY",
    origins: "[]",
    r2Key: null,
    topics: "[]",
    metadata: "{}",
    inputFormat: "PDF_TEXT",
    activeVersionId: "version-active",
    originalR2Key: acquisitionOriginalR2Key ?? null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    markedForNextResearch: 0,
    decisionStatus: null,
    ...acquisitionColumns,
  };

  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first<T>() {
          if (sql.includes("FROM distill_sessions")) return null;
          if (sql.includes("FROM sources")) {
            return {
              ...source,
              ...(sql.includes("acquisitionHasNormalizedText")
                ? { acquisitionHasNormalizedText: normalizedText?.trim() ? 1 : 0 }
                : {}),
              ...(sql.includes("acquisitionHasExtractedText")
                ? { acquisitionHasExtractedText: extractedText?.trim() ? 1 : 0 }
                : {}),
            } as T;
          }
          return null;
        },
        async all<T>() { return { results: [] as T[], success: true, meta: {} }; },
      };
    },
  } as unknown as D1Database;
}

function originalTextDb(text: { normalized: string | null; extracted: string | null }): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first<T>() {
          const activeText = sql.includes("v.extracted_text")
            ? text.normalized?.trim() ? text.normalized : text.extracted?.trim() ? text.extracted : null
            : text.normalized;
          return {
            source_id: "source-1",
            active_text: activeText,
          } as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe("Reservoir acquisition detail", () => {
  it("distinguishes a missing PDF key from a missing PDF object", async () => {
    const missingKeyResponse = await reservoir.request("/source-1/original?version=version-active", undefined, {
      DB: {
        prepare() {
          return { bind() { return this; }, async first() { return { source_id: "source-1", input_format: "PDF_TEXT", active_version_id: "version-active", active_r2_key: null, title: "자료" }; } };
        },
      },
      ORIGINALS: { get: async () => null },
    } as Env);
    expect(missingKeyResponse.status).toBe(404);
    await expect(missingKeyResponse.json()).resolves.toEqual({ error: "pdf_original_not_preserved" });

    const missingObjectResponse = await reservoir.request("/source-1/original?version=version-active", undefined, {
      DB: {
        prepare() {
          return { bind() { return this; }, async first() { return { source_id: "source-1", input_format: "PDF_TEXT", active_version_id: "version-active", active_r2_key: "originals/source-1/v1.pdf", title: "자료" }; } };
        },
      },
      ORIGINALS: { get: async () => null },
    } as Env);
    expect(missingObjectResponse.status).toBe(404);
    await expect(missingObjectResponse.json()).resolves.toEqual({ error: "pdf_original_object_missing" });
  });

  it("blocks visual extraction when the active PDF has no preserved original", async () => {
    const response = await reservoir.request("/source-1", undefined, {
      DB: detailDb({
        acquisitionTextScope: "FULLTEXT",
        acquisitionExtractionMethod: "BROWSER_PDFJS",
        acquisitionQualityStatus: "READY",
        acquisitionCharCount: 33_838,
        acquisitionError: null,
        acquisitionOriginalR2Key: null,
        normalizedText: "정제된 원문",
        extractedText: "추출 원문",
      }),
    } as Env);

    const body = await response.json() as Record<string, unknown>;
    expect(body.visualExtractionCapability).toEqual({
      state: "ORIGINAL_MISSING",
      canStart: false,
      sourceId: "source-1",
      sourceVersionId: "version-active",
      originalUrl: null,
      reasonCode: "pdf_original_not_preserved",
    });
  });

  it("reports a missing R2 object before the user starts PDF extraction", async () => {
    const response = await reservoir.request("/source-1", undefined, {
      DB: detailDb({
        acquisitionTextScope: "FULLTEXT",
        acquisitionExtractionMethod: "BROWSER_PDFJS",
        acquisitionQualityStatus: "READY",
        acquisitionCharCount: 33_838,
        acquisitionOriginalR2Key: "originals/source-1/v1.pdf",
        normalizedText: "정제된 원문",
        extractedText: "추출 원문",
      }),
      ORIGINALS: { head: async () => null },
    } as Env);

    const body = await response.json() as { visualExtractionCapability: PdfVisualExtractionCapability };
    expect(body.visualExtractionCapability.state).toBe("ORIGINAL_OBJECT_MISSING");
    expect(body.visualExtractionCapability.canStart).toBe(false);
  });

  it("returns stable active full-text provenance without exposing the text in detail JSON", async () => {
    const response = await reservoir.request("/source-1", undefined, {
      DB: detailDb({
        acquisitionTextScope: "FULLTEXT",
        acquisitionExtractionMethod: "HTML_STATIC",
        acquisitionQualityStatus: "READY",
        acquisitionCharCount: 32_739,
        acquisitionError: null,
        normalizedText: "정제된 원문",
        extractedText: "추출 원문",
      }),
    } as Env);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.acquisition).toEqual({
      textScope: "FULLTEXT",
      extractionMethod: "HTML_STATIC",
      qualityStatus: "READY",
      charCount: 32_739,
      acquisitionLabel: "원문 저장됨 · 32,739자",
      canDeepAnalyze: true,
      originalTextUrl: "/api/reservoir/source-1/original-text",
    });
    expect(body.source).not.toHaveProperty("acquisitionHasNormalizedText");
    expect(body.source).not.toHaveProperty("acquisitionHasExtractedText");
  });

  it("returns metadata-only provenance without a stored-text URL", async () => {
    const response = await reservoir.request("/source-1", undefined, {
      DB: detailDb({
        acquisitionTextScope: "METADATA_ONLY",
        acquisitionExtractionMethod: "DISCOVERY_METADATA",
        acquisitionQualityStatus: "REVIEW",
        acquisitionCharCount: 0,
        acquisitionError: "full_text_not_available",
        normalizedText: null,
        extractedText: null,
      }),
    } as Env);

    const body = await response.json() as Record<string, unknown>;
    expect(body.acquisition).toEqual({
      textScope: "METADATA_ONLY",
      extractionMethod: "DISCOVERY_METADATA",
      qualityStatus: "REVIEW",
      charCount: 0,
      acquisitionLabel: "메타데이터만 저장됨",
      canDeepAnalyze: false,
      originalTextUrl: null,
      acquisitionError: "full_text_not_available",
    });
  });

  it("does not expose a stored-text URL when only extracted text exists", async () => {
    const response = await reservoir.request("/source-1", undefined, {
      DB: detailDb({
        acquisitionTextScope: "FULLTEXT",
        acquisitionExtractionMethod: "HTML_STATIC",
        acquisitionQualityStatus: "REVIEW",
        acquisitionCharCount: 1_024,
        acquisitionError: null,
        normalizedText: null,
        extractedText: "<html><body>raw extracted HTML</body></html>",
      }),
    } as Env);

    const body = await response.json() as { acquisition: { originalTextUrl: string | null } };
    expect(body.acquisition.originalTextUrl).toBeNull();
  });
});

describe("Reservoir safe original text", () => {
  it("returns only active normalized text as text/plain and caps it at 500,000 characters", async () => {
    const normalized = `<script>alert("실행 금지")</script>${"가".repeat(500_000)}`;
    const response = await reservoir.request("/source-1/original-text", undefined, {
      DB: originalTextDb({ normalized, extracted: "대체 추출문" }),
    } as Env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await response.text();
    expect(text).toHaveLength(500_000);
    expect(text.startsWith("<script>")).toBe(true);
    expect(text).not.toContain("대체 추출문");
  });

  it("returns 404 and never serves raw extracted HTML when normalized text is empty", async () => {
    const rawExtractedHtml = "<html><body><script>alert('raw')</script></body></html>";
    const response = await reservoir.request("/source-1/original-text", undefined, {
      DB: originalTextDb({ normalized: "   ", extracted: rawExtractedHtml }),
    } as Env);

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "original_text_not_available" });
    expect(body).not.toContain(rawExtractedHtml);
  });
});
