import { describe, expect, it } from "vitest";
import reservoir from "../../../worker/src/routes/reservoir";

interface AcquisitionRow {
  acquisitionTextScope: string | null;
  acquisitionExtractionMethod: string | null;
  acquisitionQualityStatus: string | null;
  acquisitionCharCount: number | null;
  acquisitionError: string | null;
  acquisitionHasNormalizedText: number;
  acquisitionHasExtractedText: number;
}

function detailDb(acquisition: AcquisitionRow): D1Database {
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
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    markedForNextResearch: 0,
    decisionStatus: null,
    ...acquisition,
  };

  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first<T>() {
          if (sql.includes("FROM distill_sessions")) return null;
          if (sql.includes("FROM sources")) return source as T;
          return null;
        },
        async all<T>() { return { results: [] as T[], success: true, meta: {} }; },
      };
    },
  } as unknown as D1Database;
}

function originalTextDb(text: { normalized: string | null; extracted: string | null }): D1Database {
  return {
    prepare() {
      return {
        bind() { return this; },
        async first<T>() {
          return {
            source_id: "source-1",
            active_text: text.normalized?.trim() ? text.normalized : text.extracted?.trim() ? text.extracted : null,
          } as T;
        },
      };
    },
  } as unknown as D1Database;
}

describe("Reservoir acquisition detail", () => {
  it("returns stable active full-text provenance without exposing the text in detail JSON", async () => {
    const response = await reservoir.request("/source-1", undefined, {
      DB: detailDb({
        acquisitionTextScope: "FULLTEXT",
        acquisitionExtractionMethod: "HTML_STATIC",
        acquisitionQualityStatus: "READY",
        acquisitionCharCount: 32_739,
        acquisitionError: null,
        acquisitionHasNormalizedText: 1,
        acquisitionHasExtractedText: 1,
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
        acquisitionHasNormalizedText: 0,
        acquisitionHasExtractedText: 0,
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

  it("returns 404 when the active version has no normalized or extracted text", async () => {
    const response = await reservoir.request("/source-1/original-text", undefined, {
      DB: originalTextDb({ normalized: "", extracted: "" }),
    } as Env);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "original_text_not_available" });
  });
});
