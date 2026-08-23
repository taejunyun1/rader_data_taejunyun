import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText, keepVerbatimQuotes, validateDeepPayload } from "../../../worker/src/analysis/deepPrompt";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../../../worker/src/lib/openai");
  vi.doUnmock("../../../worker/src/jobs/enqueue");
  vi.doUnmock("../../../worker/src/analysis/analyze");
  vi.resetModules();
});

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

  it("blocks deep analysis for a title-only discovery version", async () => {
    const { isDeepAnalysisReady } = await import("../../../worker/src/analysis/deepAnalyze");

    const result = isDeepAnalysisReady({
      textScope: "METADATA_ONLY",
      qualityStatus: "REVIEW",
      charCount: 92,
      normalizedText: "제목",
    });

    expect(result).toEqual({
      ok: false,
      error: "deep_analysis_text_not_ready",
      textScope: "METADATA_ONLY",
      qualityStatus: "REVIEW",
      charCount: 92,
    });
  });

  it("accepts only ready full text with at least 1,000 recorded characters", async () => {
    const { isDeepAnalysisReady } = await import("../../../worker/src/analysis/deepAnalyze");

    expect(isDeepAnalysisReady({
      textScope: "FULLTEXT",
      qualityStatus: "READY",
      charCount: 1_000,
      normalizedText: "정규화 본문",
    })).toEqual({ ok: true });
    expect(isDeepAnalysisReady({
      textScope: "FULLTEXT",
      qualityStatus: "READY",
      charCount: 1_000,
      normalizedText: "   ",
    })).toMatchObject({ ok: false, error: "deep_analysis_text_not_ready" });
  });

  it("persists the active version and readiness provenance in a deep analysis", async () => {
    const callOpenAi = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({ overview: "구간 요약", arguments: [], structure: [], quotes: [], concepts: [], uncertainties: [] }),
        costUsd: 0.01,
        model: "base-model",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ overview: "전체 요약", arguments: [], structure: [], quotes: [], connections: [], researchUses: [], limitations: [] }),
        costUsd: 0.02,
        model: "review-model",
      });
    vi.doMock("../../../worker/src/lib/openai", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../../worker/src/lib/openai")>(),
      callOpenAi,
    }));
    const inserted: { sql?: string; values?: unknown[] } = {};
    const normalizedText = "정규화된 본문 ".repeat(120);
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first() {
            return {
              title: "자료",
              version_id: "version-active",
              text_scope: "FULLTEXT",
              quality_status: "READY",
              char_count: 1_234,
              normalized_text: normalizedText,
              extracted_text: normalizedText,
            };
          },
          async run() {
            inserted.sql = sql;
            inserted.values = values;
            return { success: true };
          },
        };
      },
    } as unknown as D1Database;
    const { analyzeDeepSource } = await import("../../../worker/src/analysis/deepAnalyze");

    const result = await analyzeDeepSource({ DB: db } as Env, "source-1", "precision");

    expect(result.payload.meta).toMatchObject({
      sourceCharCount: 1_234,
      textScope: "FULLTEXT",
      versionId: "version-active",
    });
    expect(inserted.sql).toContain("version_id");
    expect(inserted.values?.[2]).toBe("version-active");
  });
});

describe("deep analysis route gate", () => {
  it("returns structured 422 readiness fields before enqueueing a paid workflow", async () => {
    const enqueueResearchJob = vi.fn();
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    const db = readinessDb({
      source_id: "source-1",
      text_scope: "METADATA_ONLY",
      quality_status: "REVIEW",
      char_count: 92,
      normalized_text: "제목",
    });
    const { default: reservoir } = await import("../../../worker/src/routes/reservoir");

    const response = await reservoir.request("/source-1/deep-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "precision" }),
    }, { DB: db, MONTHLY_BUDGET_USD: "10" } as Env);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "deep_analysis_text_not_ready",
      textScope: "METADATA_ONLY",
      qualityStatus: "REVIEW",
      charCount: 92,
    });
    expect(enqueueResearchJob).not.toHaveBeenCalled();
  });

  it("preserves enqueue behavior for a ready active version", async () => {
    const enqueueResearchJob = vi.fn().mockResolvedValue({ job: { id: "deep-job" }, reused: false });
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    const db = readinessDb({
      source_id: "source-1",
      text_scope: "FULLTEXT",
      quality_status: "READY",
      char_count: 1_200,
      normalized_text: "정규화 본문",
    });
    const env = { DB: db, MONTHLY_BUDGET_USD: "10" } as Env;
    const { default: reservoir } = await import("../../../worker/src/routes/reservoir");

    const response = await reservoir.request("/source-1/deep-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "maximum" }),
    }, env);

    expect(response.status).toBe(202);
    expect(enqueueResearchJob).toHaveBeenCalledWith(
      env,
      { kind: "DEEP_ANALYSIS", input: { sourceId: "source-1", profile: "maximum" } },
      "local",
    );
  });
});

describe("inbox retry separation", () => {
  it("enqueues canonical URL acquisition for fetch=1 without analyzing", async () => {
    const enqueueResearchJob = vi.fn().mockResolvedValue({ job: { id: "fetch-job", kind: "SOURCE_ACQUISITION" }, reused: false });
    const analyzeSource = vi.fn();
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    vi.doMock("../../../worker/src/analysis/analyze", () => ({ analyzeSource }));
    const db = {
      prepare() {
        return {
          bind() { return this; },
          async first() { return { id: "source-1", canonical_url: "https://example.com/article" }; },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database;
    const env = { DB: db } as Env;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("legacy_sync_fetch_called")));
    const { default: inbox } = await import("../../../worker/src/routes/inbox");

    const response = await inbox.request("/retry/source-1?fetch=1", { method: "POST" }, env);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ job: { id: "fetch-job", kind: "SOURCE_ACQUISITION" } });
    expect(enqueueResearchJob).toHaveBeenCalledWith(
      env,
      { kind: "SOURCE_ACQUISITION", input: { sourceId: "source-1", url: "https://example.com/article" } },
      "local",
    );
    expect(analyzeSource).not.toHaveBeenCalled();
  });
});

function readinessDb(row: Record<string, unknown>): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("FROM ai_usage")) return { total: 0 };
          return row;
        },
      };
    },
  } as unknown as D1Database;
}
