import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText, keepVerbatimQuotes, validateDeepPayload } from "../../../worker/src/analysis/deepPrompt";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("../../../worker/src/lib/openai");
  vi.doUnmock("../../../worker/src/jobs/enqueue");
  vi.doUnmock("../../../worker/src/analysis/analyze");
  vi.doUnmock("../../../worker/src/analysis/budgetReservation");
  vi.doUnmock("../../../worker/src/analysis/deepAnalyze");
  vi.doUnmock("../../../worker/src/ingestion/extractUrl");
  vi.doUnmock("../../../worker/src/ingestion/versioning");
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

describe("deep analysis budget reservation", () => {
  it("allows only the first concurrent reservation when both jobs need the same remaining monthly budget", async () => {
    const { deepAnalysisReservationUsd, reserveDeepAnalysisBudget } = await import("../../../worker/src/analysis/budgetReservation");
    const env = budgetReservationEnv();
    const amountUsd = await deepAnalysisReservationUsd(env, "precision");
    const db = budgetReservationDb({ monthlyBudgetUsd: amountUsd });
    env.DB = db;

    const first = await reserveDeepAnalysisBudget(env, { researchJobId: "job-1", profile: "precision" });
    const second = await reserveDeepAnalysisBudget(env, { researchJobId: "job-2", profile: "precision" });

    expect(first).toMatchObject({ ok: true, amountUsd });
    expect(second).toEqual({ ok: false });
    expect(db.reservations.filter((row) => row.status === "RESERVED")).toHaveLength(1);
  });

  it("reuses an existing RESERVED row for the same research_job_id without inserting a second cost", async () => {
    const { reserveDeepAnalysisBudget } = await import("../../../worker/src/analysis/budgetReservation");
    const env = budgetReservationEnv();
    const db = budgetReservationDb({ monthlyBudgetUsd: 10 });
    env.DB = db;

    const first = await reserveDeepAnalysisBudget(env, { researchJobId: "job-idempotent", profile: "maximum" });
    const second = await reserveDeepAnalysisBudget(env, { researchJobId: "job-idempotent", profile: "maximum" });

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(db.reservations).toHaveLength(1);
  });

  it("releases successful and failed workflow reservations so subsequent jobs can reserve budget", async () => {
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      reservationResults: [{ ok: true, reservationId: "reservation-success", amountUsd: 0.05 }],
      analysisResults: [{ analysisId: "analysis-1", model: "review-model", costUsd: 0.02 }],
    });

    const successDb = workflowStatusDb(deepJob("job-success"));
    const successWorkflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    successWorkflow.env = { DB: successDb, MONTHLY_BUDGET_USD: "10" } as Env;

    await successWorkflow.run({ payload: { jobId: "job-success" } } as never, workflowStep());

    expect(successDb.releaseDeepAnalysisBudgetReservation).toHaveBeenCalledWith(successDb, "job-success");
    expect(successDb.completeResearchJob).toHaveBeenCalledWith(
      successDb,
      "job-success",
      expect.objectContaining({ analysisId: "analysis-1", costUsd: 0.02, model: "review-model" }),
      { view: "RESERVOIR", sourceId: "source-1", analysisId: "analysis-1" },
    );

    vi.resetModules();
    const failed = await loadDeepAnalysisWorkflow({
      reservationResults: [{ ok: true, reservationId: "reservation-failed", amountUsd: 0.05 }],
      analysisError: new Error("deep_analysis_invalid_output"),
    });
    const failedDb = workflowStatusDb(deepJob("job-failed"));
    const failedWorkflow = Object.create(failed.ResearchJobWorkflow.prototype) as { env: Env; run: typeof failed.ResearchJobWorkflow.prototype.run };
    failedWorkflow.env = { DB: failedDb, MONTHLY_BUDGET_USD: "10" } as Env;

    await expect(failedWorkflow.run({ payload: { jobId: "job-failed" } } as never, workflowStep())).rejects.toThrow("deep_analysis_invalid_output");

    expect(failedDb.releaseDeepAnalysisBudgetReservation).toHaveBeenCalledWith(failedDb, "job-failed");
    vi.doUnmock("../../../worker/src/analysis/budgetReservation");
    vi.resetModules();
    const { reserveDeepAnalysisBudget } = await import("../../../worker/src/analysis/budgetReservation");
    const reservationDb = budgetReservationDb({ monthlyBudgetUsd: 0.05 });
    const env = budgetReservationEnv(reservationDb);
    const amountUsd = await import("../../../worker/src/analysis/budgetReservation").then((mod) => mod.deepAnalysisReservationUsd(env, "precision"));
    reservationDb.monthlyBudgetUsd = amountUsd;
    const first = await reserveDeepAnalysisBudget(env, { researchJobId: "job-a", profile: "precision" });
    await import("../../../worker/src/analysis/budgetReservation").then((mod) => mod.releaseDeepAnalysisBudgetReservation(reservationDb, "job-a"));
    const second = await reserveDeepAnalysisBudget(env, { researchJobId: "job-b", profile: "precision" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("uses one INSERT SELECT statement with the budget predicate instead of a separate spend preflight", async () => {
    vi.doUnmock("../../../worker/src/analysis/budgetReservation");
    vi.resetModules();
    const { reserveDeepAnalysisBudget } = await import("../../../worker/src/analysis/budgetReservation");
    const db = budgetReservationDb({ monthlyBudgetUsd: 10 });
    const env = budgetReservationEnv(db);

    await reserveDeepAnalysisBudget(env, { researchJobId: "job-sql", profile: "precision" });

    const insertStatements = db.statements.filter((statement) => statement.sql.includes("INSERT INTO ai_budget_reservations"));
    expect(insertStatements).toHaveLength(1);
    expect(insertStatements[0].sql).toContain("INSERT INTO ai_budget_reservations");
    expect(insertStatements[0].sql).toContain("SELECT ?, ?, ?, ?, 'RESERVED', ?");
    expect(insertStatements[0].sql).toContain("COALESCE((SELECT SUM(cost_usd) FROM ai_usage WHERE month = ?), 0)");
    expect(insertStatements[0].sql).toContain("WHERE month = ? AND status = 'RESERVED'");
    expect(db.statements.filter((statement) => statement.sql.trim().startsWith("SELECT COALESCE((SELECT SUM(cost_usd)"))).toHaveLength(0);
  });

  it("keeps the reservoir spend check as a fast guard while workflow reservation failure is the final BLOCKED state", async () => {
    vi.doUnmock("../../../worker/src/analysis/budgetReservation");
    vi.doUnmock("../../../worker/src/analysis/deepAnalyze");
    vi.resetModules();
    const enqueueResearchJob = vi.fn();
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    const db = readinessDb({
      source_id: "source-1",
      text_scope: "FULLTEXT",
      quality_status: "READY",
      char_count: 1_200,
      normalized_text: "정규화 본문",
    }, 10);
    const { default: reservoir } = await import("../../../worker/src/routes/reservoir");

    const response = await reservoir.request("/source-1/deep-analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "precision" }),
    }, { DB: db, MONTHLY_BUDGET_USD: "10" } as Env);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "monthly_budget_exhausted" });
    expect(enqueueResearchJob).not.toHaveBeenCalled();

    vi.resetModules();
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      reservationResults: [{ ok: false }],
      analysisResults: [{ analysisId: "should-not-run", model: "review-model", costUsd: 0 }],
    });
    const workflowDb = workflowStatusDb(deepJob("job-blocked"));
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = { DB: workflowDb, MONTHLY_BUDGET_USD: "10" } as Env;

    await expect(workflow.run({ payload: { jobId: "job-blocked" } } as never, workflowStep())).rejects.toThrow("monthly_budget_exhausted");

    expect(workflowDb.blockResearchJob).toHaveBeenCalledWith(workflowDb, "job-blocked", "monthly_budget_exhausted", "monthly_budget_exhausted");
    expect(workflowDb.analyzeDeepSource).not.toHaveBeenCalled();
  });
});

describe("inbox retry separation", () => {
  it("reanalyzes the current active version for analyze=1 without remote fetch", async () => {
    const enqueueResearchJob = vi.fn();
    const analyzeSource = vi.fn().mockResolvedValue({ status: "analyzed", sourceId: "source-1" });
    const remoteFetch = vi.fn().mockRejectedValue(new Error("remote_fetch_called"));
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    vi.doMock("../../../worker/src/analysis/analyze", () => ({ analyzeSource }));
    vi.stubGlobal("fetch", remoteFetch);
    const env = { DB: {} as D1Database } as Env;
    const { default: inbox } = await import("../../../worker/src/routes/inbox");

    const response = await inbox.request("/retry/source-1?analyze=1", { method: "POST" }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "analyzed", sourceId: "source-1" });
    expect(analyzeSource).toHaveBeenCalledWith(env, "source-1");
    expect(remoteFetch).not.toHaveBeenCalled();
    expect(enqueueResearchJob).not.toHaveBeenCalled();
  });

  it("retains the legacy synchronous refetch path without retry query flags", async () => {
    const enqueueResearchJob = vi.fn();
    const analyzeSource = vi.fn().mockResolvedValue({ status: "analyzed" });
    const fetchAndExtract = vi.fn().mockResolvedValue({
      html: "<html><body>원문</body></html>",
      title: "자료",
      text: "충분한 원문 ".repeat(300),
      siteName: "Example",
      description: null,
      finalUrl: "https://example.com/final",
      warnings: [],
      scope: "FULLTEXT",
      method: "HTML_STATIC",
    });
    const appendAcquisitionVersion = vi.fn().mockResolvedValue({
      versionId: "version-retry",
      version: 2,
      qualityStatus: "READY",
    });
    const getActiveVersion = vi.fn()
      .mockResolvedValueOnce({ id: "version-active", version_origin: "INITIAL_INGEST" })
      .mockResolvedValueOnce({ id: "version-retry", version_origin: "REEXTRACT" });
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    vi.doMock("../../../worker/src/analysis/analyze", () => ({ analyzeSource }));
    vi.doMock("../../../worker/src/ingestion/extractUrl", () => ({ fetchAndExtract }));
    vi.doMock("../../../worker/src/ingestion/versioning", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../../worker/src/ingestion/versioning")>(),
      appendAcquisitionVersion,
      getActiveVersion,
    }));
    const db = retryDb();
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { DB: db, ORIGINALS: { put } } as unknown as Env;
    const { default: inbox } = await import("../../../worker/src/routes/inbox");

    const response = await inbox.request("/retry/source-1", { method: "POST" }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      versionId: "version-retry",
      version: 2,
      qualityStatus: "READY",
    });
    expect(fetchAndExtract).toHaveBeenCalledWith("https://example.com/article");
    expect(appendAcquisitionVersion).toHaveBeenCalledWith(db, expect.objectContaining({
      sourceId: "source-1",
      extractedText: "충분한 원문 ".repeat(300),
      finalUrl: "https://example.com/final",
      versionOrigin: "REEXTRACT",
    }));
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^originals\/source-1\/acq-/),
      "<html><body>원문</body></html>",
      { customMetadata: { sourceId: "source-1", versionId: expect.any(String), origin: "REEXTRACT" } },
    );
    expect(analyzeSource).toHaveBeenCalledWith(env, "source-1");
    expect(enqueueResearchJob).not.toHaveBeenCalled();
  });

  it("retains the legacy synchronous reextract path for URL sources", async () => {
    const analyzeSource = vi.fn().mockResolvedValue({ status: "analyzed" });
    const fetchAndExtract = vi.fn().mockResolvedValue({
      html: "<html><body>재추출 원문</body></html>",
      title: "자료",
      text: "재추출 본문 ".repeat(320),
      siteName: "Example",
      description: null,
      finalUrl: "https://example.com/reextract-final",
      warnings: [],
      scope: "FULLTEXT",
      method: "HTML_STATIC",
    });
    const appendAcquisitionVersion = vi.fn().mockResolvedValue({
      versionId: "version-reextract",
      version: 3,
      qualityStatus: "READY",
    });
    const getActiveVersion = vi.fn()
      .mockResolvedValueOnce({ id: "version-active", version_origin: "INITIAL_INGEST" })
      .mockResolvedValueOnce({ id: "version-reextract", version_origin: "REEXTRACT" });
    vi.doMock("../../../worker/src/analysis/analyze", () => ({ analyzeSource }));
    vi.doMock("../../../worker/src/ingestion/extractUrl", () => ({ fetchAndExtract }));
    vi.doMock("../../../worker/src/ingestion/versioning", async (importOriginal) => ({
      ...await importOriginal<typeof import("../../../worker/src/ingestion/versioning")>(),
      appendAcquisitionVersion,
      getActiveVersion,
    }));
    const db = retryDb();
    const put = vi.fn().mockResolvedValue(undefined);
    const env = { DB: db, ORIGINALS: { put } } as unknown as Env;
    const { default: inbox } = await import("../../../worker/src/routes/inbox");

    const response = await inbox.request("/source-1/reextract", { method: "POST" }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      sourceId: "source-1",
      versionId: "version-reextract",
      version: 3,
      status: "ACTIVE",
      qualityStatus: "READY",
    });
    expect(fetchAndExtract).toHaveBeenCalledWith("https://example.com/article");
    expect(appendAcquisitionVersion).toHaveBeenCalledWith(db, expect.objectContaining({
      sourceId: "source-1",
      extractedText: "재추출 본문 ".repeat(320),
      finalUrl: "https://example.com/reextract-final",
      versionOrigin: "REEXTRACT",
    }));
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^originals\/source-1\/acq-/),
      "<html><body>재추출 원문</body></html>",
      { customMetadata: { sourceId: "source-1", versionId: expect.any(String), origin: "REEXTRACT" } },
    );
    expect(analyzeSource).toHaveBeenCalledWith(env, "source-1");
  });

  it("enqueues canonical URL acquisition for fetch=1 without analyzing", async () => {
    const enqueueResearchJob = vi.fn().mockResolvedValue({ job: { id: "fetch-job", kind: "SOURCE_ACQUISITION" }, reused: false });
    const analyzeSource = vi.fn();
    const fetchAndExtract = vi.fn().mockRejectedValue(new Error("legacy_sync_fetch_called"));
    vi.doMock("../../../worker/src/jobs/enqueue", () => ({ enqueueResearchJob }));
    vi.doMock("../../../worker/src/analysis/analyze", () => ({ analyzeSource }));
    vi.doMock("../../../worker/src/ingestion/extractUrl", () => ({ fetchAndExtract }));
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
    expect(fetchAndExtract).not.toHaveBeenCalled();
  });
});

function readinessDb(row: Record<string, unknown>, aiUsageTotal = 0): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes("FROM ai_usage")) return { total: aiUsageTotal };
          return row;
        },
      };
    },
  } as unknown as D1Database;
}

interface BudgetReservationRow {
  id: string;
  month: string;
  researchJobId: string;
  amountUsd: number;
  status: "RESERVED" | "RELEASED";
  createdAt: string;
  releasedAt: string | null;
}

interface BudgetReservationStatement {
  sql: string;
  values: unknown[];
}

function budgetReservationEnv(db: D1Database = budgetReservationDb({ monthlyBudgetUsd: 10 })): Env {
  return {
    DB: db,
    MONTHLY_BUDGET_USD: "10",
    MODEL_HIGH: "base-model",
    MODEL_DEEP: "review-model",
    MODEL_LOW: "low-model",
    MODEL_PRICING_JSON: JSON.stringify({
      "base-model": { input: 1, output: 2 },
      "review-model": { input: 3, output: 4 },
    }),
    MODEL_UNKNOWN_INPUT_USD: "5",
    MODEL_UNKNOWN_OUTPUT_USD: "30",
  } as unknown as Env;
}

function budgetReservationDb(input: { monthlyBudgetUsd: number; usageUsd?: number }) {
  const db = {
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    usageUsd: input.usageUsd ?? 0,
    reservations: [] as BudgetReservationRow[],
    statements: [] as BudgetReservationStatement[],
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first() {
          db.statements.push({ sql, values });
          if (sql === "SELECT value FROM kv WHERE key = ?") return null;
          if (sql.includes("FROM ai_usage")) return { total: db.usageUsd };
          if (sql.includes("FROM ai_budget_reservations") && sql.includes("research_job_id = ?")) {
            const researchJobId = String(values[0]);
            const row = db.reservations.find((item) => item.researchJobId === researchJobId && item.status === "RESERVED");
            return row ? { id: row.id, amount_usd: row.amountUsd } : null;
          }
          return null;
        },
        async run() {
          db.statements.push({ sql, values });
          if (sql.includes("INSERT INTO ai_budget_reservations")) {
            const [id, month, researchJobId, amountUsd, createdAt] = values;
            const existing = db.reservations.some((row) => row.researchJobId === researchJobId);
            const reserved = db.reservations
              .filter((row) => row.month === month && row.status === "RESERVED")
              .reduce((sum, row) => sum + row.amountUsd, 0);
            if (!existing && db.usageUsd + reserved + Number(amountUsd) <= db.monthlyBudgetUsd) {
              db.reservations.push({
                id: String(id),
                month: String(month),
                researchJobId: String(researchJobId),
                amountUsd: Number(amountUsd),
                status: "RESERVED",
                createdAt: String(createdAt),
                releasedAt: null,
              });
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          }
          if (sql.includes("UPDATE ai_budget_reservations")) {
            const [releasedAt, researchJobId] = values;
            let changes = 0;
            for (const row of db.reservations) {
              if (row.researchJobId === researchJobId && row.status === "RESERVED") {
                row.status = "RELEASED";
                row.releasedAt = String(releasedAt);
                changes += 1;
              }
            }
            return { success: true, meta: { changes } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return statement;
    },
  };
  return db as typeof db & D1Database;
}

function deepJob(id: string) {
  return {
    id,
    kind: "DEEP_ANALYSIS",
    input: { sourceId: "source-1", profile: "precision" },
  };
}

function workflowStep() {
  return {
    do: vi.fn(async (_name: string, ...args: unknown[]) => {
      const callback = args.at(-1) as () => unknown;
      return callback();
    }),
  };
}

function workflowStatusDb(job: ReturnType<typeof deepJob>) {
  return {
    job,
    getResearchJob: vi.fn().mockResolvedValue(job),
    markJobRunning: vi.fn().mockResolvedValue(undefined),
    updateJobProgress: vi.fn().mockResolvedValue(undefined),
    completeResearchJob: vi.fn().mockResolvedValue(undefined),
    failResearchJob: vi.fn().mockResolvedValue(undefined),
    blockResearchJob: vi.fn().mockResolvedValue(undefined),
    reserveDeepAnalysisBudget: vi.fn(),
    releaseDeepAnalysisBudgetReservation: vi.fn().mockResolvedValue(undefined),
    analyzeDeepSource: vi.fn(),
    prepare() {
      return {
        bind() { return this; },
        async first() { return null; },
        async run() { return { success: true, meta: { changes: 0 } }; },
      };
    },
  } as unknown as D1Database & {
    getResearchJob: ReturnType<typeof vi.fn>;
    markJobRunning: ReturnType<typeof vi.fn>;
    updateJobProgress: ReturnType<typeof vi.fn>;
    completeResearchJob: ReturnType<typeof vi.fn>;
    failResearchJob: ReturnType<typeof vi.fn>;
    blockResearchJob: ReturnType<typeof vi.fn>;
    reserveDeepAnalysisBudget: ReturnType<typeof vi.fn>;
    releaseDeepAnalysisBudgetReservation: ReturnType<typeof vi.fn>;
    analyzeDeepSource: ReturnType<typeof vi.fn>;
  };
}

async function loadDeepAnalysisWorkflow(input: {
  reservationResults: ({ ok: true; reservationId: string; amountUsd: number } | { ok: false })[];
  analysisResults?: { analysisId: string; model: string; costUsd: number }[];
  analysisError?: Error;
}) {
  vi.doMock("../../../worker/src/jobs/store", () => ({
    getResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string) => db.getResearchJob(id),
    markJobRunning: (db: ReturnType<typeof workflowStatusDb>, id: string, message: string) => db.markJobRunning(db, id, message),
    updateJobProgress: (db: ReturnType<typeof workflowStatusDb>, id: string, progress: number, message: string) => db.updateJobProgress(db, id, progress, message),
    completeResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string, result: unknown, resultRef: unknown) => db.completeResearchJob(db, id, result, resultRef),
    failResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string, errorCode: string, error: string) => db.failResearchJob(db, id, errorCode, error),
    blockResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string, errorCode: string, error: string) => db.blockResearchJob(db, id, errorCode, error),
  }));
  vi.doMock("../../../worker/src/analysis/budgetReservation", () => ({
    reserveDeepAnalysisBudget: (env: Env, reservationInput: { researchJobId: string; profile: "precision" | "maximum" }) => {
      const db = env.DB as ReturnType<typeof workflowStatusDb>;
      const result = input.reservationResults.shift() ?? { ok: false };
      db.reserveDeepAnalysisBudget(env, reservationInput);
      return result;
    },
    releaseDeepAnalysisBudgetReservation: (db: ReturnType<typeof workflowStatusDb>, researchJobId: string) => db.releaseDeepAnalysisBudgetReservation(db, researchJobId),
  }));
  vi.doMock("../../../worker/src/analysis/deepAnalyze", () => ({
    analyzeDeepSource: (env: Env, sourceId: string, profile: "precision" | "maximum") => {
      const db = env.DB as ReturnType<typeof workflowStatusDb>;
      db.analyzeDeepSource(env, sourceId, profile);
      if (input.analysisError) throw input.analysisError;
      return input.analysisResults?.shift() ?? { analysisId: "analysis-default", model: "review-model", costUsd: 0.01 };
    },
  }));
  return import("../../../worker/src/workflows/researchJob");
}

function retryDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async first() {
          if (sql === "SELECT id, canonical_url FROM sources WHERE id = ?") {
            return { id: "source-1", canonical_url: "https://example.com/article" };
          }
          if (sql === "SELECT id, title, input_format, canonical_url, r2_key FROM sources WHERE id = ?") {
            return {
              id: "source-1",
              title: "자료",
              input_format: "URL_HTML",
              canonical_url: "https://example.com/article",
              r2_key: "originals/source-1/v1",
            };
          }
          return null;
        },
        async run() { return { success: true }; },
      };
    },
  } as unknown as D1Database;
}
