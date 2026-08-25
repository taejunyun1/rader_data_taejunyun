import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkText, keepVerbatimQuotes, validateDeepPayload } from "../../../worker/src/analysis/deepPrompt";
import { createVisualExtractionVisionGate, type VisualExtractionVisionGate } from "../../../worker/src/visual/extraction/visionBudget";

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

describe("ephemeral visual analysis boundary", () => {
  it("stores LINK_ONLY visual analysis from provided bytes without requiring a capsule version", async () => {
    const embedText = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    vi.doMock("../../../worker/src/lib/embed", () => ({ embedText }));
    const inserted: { analysis?: unknown[]; assetUpdate?: unknown[]; embedding?: unknown[] } = {};
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first() {
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO visual_analyses")) inserted.analysis = values;
            if (sql.includes("UPDATE visual_assets SET visual_kind")) inserted.assetUpdate = values;
            if (sql.includes("INSERT OR REPLACE INTO visual_embeddings")) inserted.embedding = values;
            return { success: true };
          },
        };
      },
      async batch(statements: Array<{ run: () => Promise<unknown> }>) {
        for (const statement of statements) await statement.run();
        return [];
      },
    } as unknown as D1Database;
    const env = {
      DB: db,
      AI: {
        run: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            visualKind: "DOCUMENT_SCAN",
            confidence: 0.82,
            observation: { visibleText: ["Figure 2"], subject: ["printed page"] },
            formal: { planes: ["flat page"] },
            context: { medium: ["book scan"] },
            propositions: ["캡션과 이미지의 관계를 대조한다."],
            uncertainty: [],
          }),
        }),
      },
      MODEL_VISION: "vision-model",
      VECTOR_INDEX: { upsert: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env;
    const { analyzeVisualVersionBytes } = await import("../../../worker/src/visual/analyzer");

    const result = await analyzeVisualVersionBytes(env, {
      visualAssetId: "asset-link",
      visualVersionId: "version-link",
      bytes: new TextEncoder().encode("webp-like-bytes").buffer,
      filename: "page-4.webp",
      mimeType: "image/webp",
      width: 900,
      height: 1200,
      caption: "Figure 2. Annotated scan",
      storageState: "LINK_ONLY",
    });

    expect(result.visualVersionId).toBe("version-link");
    expect(inserted.analysis?.[1]).toBe("asset-link");
    expect(inserted.analysis?.[2]).toBe("version-link");
    expect(inserted.assetUpdate).toEqual([
      "DOCUMENT_SCAN",
      "LINK_ONLY",
      expect.any(String),
      "asset-link",
    ]);
    expect(inserted.embedding?.[1]).toBe("asset-link");
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

  it("keeps a failed analysis attempt reservation through the workflow step retry", async () => {
    vi.doUnmock("../../../worker/src/analysis/budgetReservation");
    vi.resetModules();
    const db = workflowBudgetReservationDb(deepJob("job-retry"), { monthlyBudgetUsd: 10 });
    const env = budgetReservationEnv(db);
    const { deepAnalysisReservationUsd } = await import("../../../worker/src/analysis/budgetReservation");
    const amountUsd = await deepAnalysisReservationUsd(env, "precision");
    db.monthlyBudgetUsd = amountUsd;
    let attempts = 0;
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      useRealReservation: true,
      analyzeDeepSource: async () => {
        attempts += 1;
        if (attempts === 1) {
          db.usageUsd = amountUsd;
          throw new Error("deep_analysis_invalid_output");
        }
        return { analysisId: "analysis-retry", model: "review-model", costUsd: amountUsd };
      },
    });
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = env;

    await workflow.run({ payload: { jobId: "job-retry" } } as never, retryingWorkflowStep("execute-deep_analysis"));

    expect(attempts).toBe(2);
    expect(db.reservations).toHaveLength(1);
    expect(db.reservations[0]).toMatchObject({ researchJobId: "job-retry", status: "RELEASED" });
    expect(db.reserveInsertChanges).toEqual([1, 0]);
    expect(db.completeResearchJob).toHaveBeenCalledWith(
      db,
      "job-retry",
      expect.objectContaining({ analysisId: "analysis-retry" }),
      { view: "RESERVOIR", sourceId: "source-1", analysisId: "analysis-retry" },
    );
    expect(db.blockResearchJob).not.toHaveBeenCalled();
    expect(db.failResearchJob).not.toHaveBeenCalled();
  });

  it("does not replace the primary analysis error when failure cleanup release fails", async () => {
    vi.resetModules();
    const releaseLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      reservationResults: [{ ok: true, reservationId: "reservation-primary-error", amountUsd: 0.05 }],
      analysisError: new Error("deep_analysis_invalid_output"),
      releaseError: new Error("release_failed"),
    });
    const db = workflowStatusDb(deepJob("job-primary-error"));
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = { DB: db, MONTHLY_BUDGET_USD: "10" } as Env;

    await expect(workflow.run({ payload: { jobId: "job-primary-error" } } as never, workflowStep())).rejects.toThrow("deep_analysis_invalid_output");

    expect(db.failResearchJob).toHaveBeenCalledWith(db, "job-primary-error", "workflow_runtime_failed", "deep_analysis_invalid_output");
    expect(db.blockResearchJob).not.toHaveBeenCalled();
    expect(JSON.parse(String(releaseLog.mock.calls[0]?.[0]))).toMatchObject({
      level: "error",
      scope: "workflow:deep-analysis-budget-release",
      researchJobId: "job-primary-error",
      message: "release_failed",
      originalError: "deep_analysis_invalid_output",
    });
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

  it("reuses the same reservation boundary for visual analysis with a fixed estimate", async () => {
    const { reserveVisualAnalysisBudget, visualAnalysisReservationUsd } = await import("../../../worker/src/analysis/budgetReservation");
    const env = budgetReservationEnv();
    const amountUsd = await visualAnalysisReservationUsd(env);
    const db = budgetReservationDb({ monthlyBudgetUsd: amountUsd });
    env.DB = db;

    const first = await reserveVisualAnalysisBudget(env, { researchJobId: "job-visual-1" });
    const second = await reserveVisualAnalysisBudget(env, { researchJobId: "job-visual-2" });

    expect(first).toMatchObject({ ok: true, amountUsd });
    expect(second).toEqual({ ok: false });
    expect(db.reservations.filter((row) => row.status === "RESERVED")).toHaveLength(1);
  });

  it("reserves the extraction-wide 80-call visual ceiling through the same atomic budget boundary", async () => {
    const { reserveVisualExtractionBudget, visualExtractionReservationUsd } = await import(
      "../../../worker/src/analysis/budgetReservation"
    );
    const env = budgetReservationEnv();
    const amountUsd = await visualExtractionReservationUsd(env);
    const db = budgetReservationDb({ monthlyBudgetUsd: amountUsd });
    env.DB = db;

    const first = await reserveVisualExtractionBudget(env, { researchJobId: "job-extraction-1" });
    const second = await reserveVisualExtractionBudget(env, { researchJobId: "job-extraction-2" });

    expect(amountUsd).toBe(0.8);
    expect(first).toMatchObject({ ok: true, amountUsd });
    expect(second).toEqual({ ok: false });
    expect(db.reservations.filter((row) => row.status === "RESERVED")).toHaveLength(1);
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

describe("visual extraction workflow", () => {
  it("executes the visual extraction runner instead of blocking the job as pipeline-not-ready", async () => {
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      visualExtractionResults: [{
        sourceId: "source-1",
        sourceVersionId: "version-1",
        extractionRunId: "run-visual-1",
        status: "PARTIAL",
        counts: { selected: 1, review: 1, filtered: 3, unavailable: 2 },
        diagnostics: {
          sourceKind: "HTML",
          limits: { htmlCandidates: 40, htmlFetch: 12, pdfPages: 40 },
          blocked: { htmlCandidates: 8, htmlFetch: 0, pdfPages: 0 },
        },
      }],
    });
    const job = {
      id: "job-visual-extraction",
      kind: "VISUAL_EXTRACTION",
      input: { sourceId: "source-1", sourceVersionId: "version-1", extractionRunId: "run-visual-1" },
    };
    const db = workflowStatusDb(job as ReturnType<typeof deepJob>);
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = { DB: db } as Env;

    await workflow.run({ payload: { jobId: "job-visual-extraction" } } as never, workflowStep());

    expect(db.completeResearchJob).toHaveBeenCalledWith(
      db,
      "job-visual-extraction",
      expect.objectContaining({
        extractionRunId: "run-visual-1",
        counts: expect.objectContaining({ unavailable: 2 }),
      }),
      { view: "VISUAL", sourceId: "source-1", extractionRunId: "run-visual-1" },
    );
    expect(db.blockResearchJob).not.toHaveBeenCalled();
    expect(db.failResearchJob).not.toHaveBeenCalled();
  });

  it("continues extraction with a blocked gate, REVIEW fallback diagnostics, and no model usage", async () => {
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      extractionReservationResults: [{ ok: false }],
      visualExtractionResults: [{
        sourceId: "source-budget",
        sourceVersionId: "version-budget",
        extractionRunId: "run-budget",
        status: "SUCCEEDED",
        counts: { selected: 0, review: 1, filtered: 0, unavailable: 0 },
        diagnostics: {
          sourceKind: "PDF",
          limits: { htmlCandidates: 40, htmlFetch: 12, pdfPages: 40 },
          blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
          vision: {
            callLimit: 80,
            reservationUsd: 0.8,
            budgetReserved: false,
            budgetBlocked: true,
            attempted: 1,
            completed: 0,
            failed: 0,
            blocked: 1,
            capBlocked: 0,
          },
        },
      }],
    });
    const job = {
      id: "job-extraction-budget-blocked",
      kind: "VISUAL_EXTRACTION",
      input: { sourceId: "source-budget", sourceVersionId: "version-budget", extractionRunId: "run-budget" },
    };
    const db = workflowStatusDb(job as ReturnType<typeof deepJob>);
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = { DB: db, MONTHLY_BUDGET_USD: "10" } as Env;

    await workflow.run({ payload: { jobId: job.id } } as never, workflowStep());

    expect(db.reserveVisualExtractionBudget).toHaveBeenCalledWith(
      { DB: db, MONTHLY_BUDGET_USD: "10" },
      { researchJobId: job.id },
    );
    expect(db.completeResearchJob).toHaveBeenCalledWith(
      db,
      job.id,
      expect.objectContaining({
        diagnostics: expect.objectContaining({
          vision: expect.objectContaining({ budgetBlocked: true, completed: 0 }),
        }),
      }),
      { view: "VISUAL", sourceId: "source-budget", extractionRunId: "run-budget" },
    );
    expect(db.blockResearchJob).not.toHaveBeenCalled();
    expect(db.failResearchJob).not.toHaveBeenCalled();
  });

  it("reuses one extraction reservation and call gate across workflow step retries", async () => {
    let attempts = 0;
    let extractionGate: VisualExtractionVisionGate | undefined;
    const modelCall = vi.fn().mockResolvedValue("ok");
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      extractionReservationResults: [{ ok: true, reservationId: "reservation-extraction-retry", amountUsd: 0.8 }],
      visualExtractionRunner: async (_env, extractionInput) => {
        attempts += 1;
        extractionGate ??= createVisualExtractionVisionGate(extractionInput.visionBudget);
        await extractionGate.execute(modelCall);
        if (attempts === 1) throw new Error("transient_extraction_failure");
        return {
          sourceId: "source-retry",
          sourceVersionId: "version-retry",
          extractionRunId: "run-retry",
          status: "SUCCEEDED",
          counts: { selected: 0, review: 0, filtered: 0, unavailable: 0 },
          outcomeCounts: { duplicateExact: 0, duplicateNear: 0, rightsGated: 0, cleanupFailures: 0 },
          diagnostics: {
            sourceKind: "PDF",
            limits: { htmlCandidates: 40, htmlFetch: 12, pdfPages: 40 },
            blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
            vision: extractionGate.snapshot(),
          },
        };
      },
    });
    const job = {
      id: "job-extraction-retry",
      kind: "VISUAL_EXTRACTION",
      input: { sourceId: "source-retry", sourceVersionId: "version-retry", extractionRunId: "run-retry" },
    };
    const db = workflowStatusDb(job as ReturnType<typeof deepJob>);
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = { DB: db, MONTHLY_BUDGET_USD: "10" } as Env;

    await workflow.run(
      { payload: { jobId: job.id } } as never,
      retryingWorkflowStep("execute-visual_extraction"),
    );

    expect(attempts).toBe(2);
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(db.reserveVisualExtractionBudget).toHaveBeenCalledTimes(1);
    expect(db.completeResearchJob).toHaveBeenCalledWith(
      db,
      job.id,
      expect.objectContaining({ diagnostics: expect.objectContaining({ vision: expect.objectContaining({ attempted: 2, completed: 2 }) }) }),
      expect.any(Object),
    );
  });

  it("downgrades a visual candidate to REVIEW instead of blocking the job when the visual budget is exhausted", async () => {
    const { ResearchJobWorkflow } = await loadDeepAnalysisWorkflow({
      visualReservationResults: [{ ok: false }],
    });
    const job = {
      id: "job-visual-budget-blocked",
      kind: "VISUAL_ANALYSIS",
      input: { visualAssetId: "asset-budget-blocked" },
    };
    const db = workflowStatusDb(job as ReturnType<typeof deepJob>);
    const workflow = Object.create(ResearchJobWorkflow.prototype) as { env: Env; run: typeof ResearchJobWorkflow.prototype.run };
    workflow.env = { DB: db, MONTHLY_BUDGET_USD: "10" } as Env;

    await workflow.run({ payload: { jobId: "job-visual-budget-blocked" } } as never, workflowStep());

    expect(db.reserveVisualAnalysisBudget).toHaveBeenCalledWith(
      { DB: db, MONTHLY_BUDGET_USD: "10" },
      { researchJobId: "job-visual-budget-blocked" },
    );
    expect(db.visualAssetReviewFallbacks).toEqual([
      {
        id: "asset-budget-blocked",
        selectionStatus: "REVIEW",
        selectionReason: "visual_analysis_skipped_monthly_budget_exhausted",
        processingStatus: "READY",
        lastError: "monthly_budget_exhausted",
      },
    ]);
    expect(db.blockResearchJob).not.toHaveBeenCalled();
    expect(db.completeResearchJob).toHaveBeenCalledWith(
      db,
      "job-visual-budget-blocked",
      expect.objectContaining({ visualAssetId: "asset-budget-blocked", budgetBlocked: true }),
      { view: "VISUAL", visualAssetId: "asset-budget-blocked" },
    );
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

function retryingWorkflowStep(retryStepName: string) {
  return {
    do: vi.fn(async (name: string, ...args: unknown[]) => {
      const callback = args.at(-1) as () => unknown;
      try {
        return await callback();
      } catch (error) {
        if (name === retryStepName) return callback();
        throw error;
      }
    }),
  };
}

function workflowStatusDb(job: ReturnType<typeof deepJob>) {
  const db = {
    job,
    getResearchJob: vi.fn().mockResolvedValue(job),
    markJobRunning: vi.fn().mockResolvedValue(undefined),
    updateJobProgress: vi.fn().mockResolvedValue(undefined),
    completeResearchJob: vi.fn().mockResolvedValue(undefined),
    failResearchJob: vi.fn().mockResolvedValue(undefined),
    blockResearchJob: vi.fn().mockResolvedValue(undefined),
    reserveDeepAnalysisBudget: vi.fn(),
    reserveVisualAnalysisBudget: vi.fn(),
    reserveVisualExtractionBudget: vi.fn(),
    releaseDeepAnalysisBudgetReservation: vi.fn().mockResolvedValue(undefined),
    releaseAnalysisBudgetReservation: vi.fn().mockResolvedValue(undefined),
    analyzeDeepSource: vi.fn(),
    visualAssetReviewFallbacks: [] as Array<{
      id: string;
      selectionStatus: string;
      selectionReason: string;
      processingStatus: string;
      lastError: string;
    }>,
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) {
          values = next;
          return this;
        },
        async first() { return null; },
        async run() {
          if (sql.includes("UPDATE visual_assets") && sql.includes("selection_status = 'REVIEW'")) {
            const [selectionReason, _updatedAt, id] = values as [string, string, string];
            db.visualAssetReviewFallbacks.push({
              id,
              selectionStatus: "REVIEW",
              selectionReason,
              processingStatus: "READY",
              lastError: "monthly_budget_exhausted",
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
    },
  };
  return db as unknown as D1Database & {
    getResearchJob: ReturnType<typeof vi.fn>;
    markJobRunning: ReturnType<typeof vi.fn>;
    updateJobProgress: ReturnType<typeof vi.fn>;
    completeResearchJob: ReturnType<typeof vi.fn>;
    failResearchJob: ReturnType<typeof vi.fn>;
    blockResearchJob: ReturnType<typeof vi.fn>;
    reserveDeepAnalysisBudget: ReturnType<typeof vi.fn>;
    reserveVisualAnalysisBudget: ReturnType<typeof vi.fn>;
    reserveVisualExtractionBudget: ReturnType<typeof vi.fn>;
    releaseDeepAnalysisBudgetReservation: ReturnType<typeof vi.fn>;
    releaseAnalysisBudgetReservation: ReturnType<typeof vi.fn>;
    analyzeDeepSource: ReturnType<typeof vi.fn>;
    visualAssetReviewFallbacks: Array<{
      id: string;
      selectionStatus: string;
      selectionReason: string;
      processingStatus: string;
      lastError: string;
    }>;
  };
}

function workflowBudgetReservationDb(job: ReturnType<typeof deepJob>, input: { monthlyBudgetUsd: number; usageUsd?: number }) {
  const db = budgetReservationDb(input) as ReturnType<typeof budgetReservationDb> & ReturnType<typeof workflowStatusDb> & {
    reserveInsertChanges: number[];
  };
  Object.assign(db, {
    job,
    reserveInsertChanges: [] as number[],
    getResearchJob: vi.fn().mockResolvedValue(job),
    markJobRunning: vi.fn().mockResolvedValue(undefined),
    updateJobProgress: vi.fn().mockResolvedValue(undefined),
    completeResearchJob: vi.fn().mockResolvedValue(undefined),
    failResearchJob: vi.fn().mockResolvedValue(undefined),
    blockResearchJob: vi.fn().mockResolvedValue(undefined),
    reserveDeepAnalysisBudget: vi.fn(),
    releaseDeepAnalysisBudgetReservation: vi.fn().mockResolvedValue(undefined),
    analyzeDeepSource: vi.fn(),
  });
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("INSERT INTO ai_budget_reservations")) return statement;
    const originalRun = statement.run.bind(statement);
    statement.run = async () => {
      const result = await originalRun();
      db.reserveInsertChanges.push(Number(result.meta?.changes ?? 0));
      return result;
    };
    return statement;
  };
  return db;
}

async function loadDeepAnalysisWorkflow(input: {
  reservationResults?: ({ ok: true; reservationId: string; amountUsd: number } | { ok: false })[];
  visualReservationResults?: ({ ok: true; reservationId: string; amountUsd: number } | { ok: false })[];
  extractionReservationResults?: ({ ok: true; reservationId: string; amountUsd: number } | { ok: false })[];
  analysisResults?: { analysisId: string; model: string; costUsd: number }[];
  analysisError?: Error;
  releaseError?: Error;
  useRealReservation?: boolean;
  analyzeDeepSource?: (env: Env, sourceId: string, profile: "precision" | "maximum") => Promise<{ analysisId: string; model: string; costUsd: number }>;
  visualExtractionResults?: Array<{
    sourceId: string;
    sourceVersionId: string;
    extractionRunId: string;
    status: "SUCCEEDED" | "PARTIAL" | "FAILED";
    counts: { selected: number; review: number; filtered: number; unavailable: number };
    diagnostics: {
      sourceKind: "HTML" | "PDF";
      limits: { htmlCandidates: number; htmlFetch: number; pdfPages: number };
      blocked: { htmlCandidates: number; htmlFetch: number; pdfPages: number };
      vision?: {
        callLimit: number;
        reservationUsd: number;
        budgetReserved: boolean;
        budgetBlocked: boolean;
        attempted: number;
        completed: number;
        failed: number;
        blocked: number;
        capBlocked: number;
      };
    };
  }>;
  visualExtractionRunner?: (
    env: Env,
    input: {
      sourceId: string;
      sourceVersionId: string;
      extractionRunId?: string;
      visionBudget: {
        budgetReserved: boolean;
        reservationUsd: number;
      };
    },
  ) => Promise<NonNullable<typeof input.visualExtractionResults>[number]>;
}) {
  vi.doMock("../../../worker/src/jobs/store", () => ({
    getResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string) => db.getResearchJob(id),
    markJobRunning: (db: ReturnType<typeof workflowStatusDb>, id: string, message: string) => db.markJobRunning(db, id, message),
    updateJobProgress: (db: ReturnType<typeof workflowStatusDb>, id: string, progress: number, message: string) => db.updateJobProgress(db, id, progress, message),
    completeResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string, result: unknown, resultRef: unknown) => db.completeResearchJob(db, id, result, resultRef),
    failResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string, errorCode: string, error: string) => db.failResearchJob(db, id, errorCode, error),
    blockResearchJob: (db: ReturnType<typeof workflowStatusDb>, id: string, errorCode: string, error: string) => db.blockResearchJob(db, id, errorCode, error),
  }));
  if (input.useRealReservation) {
    vi.doUnmock("../../../worker/src/analysis/budgetReservation");
  } else {
    vi.doMock("../../../worker/src/analysis/budgetReservation", () => ({
      reserveDeepAnalysisBudget: (env: Env, reservationInput: { researchJobId: string; profile: "precision" | "maximum" }) => {
        const db = env.DB as ReturnType<typeof workflowStatusDb>;
        const result = input.reservationResults?.shift() ?? { ok: false };
        db.reserveDeepAnalysisBudget(env, reservationInput);
        return result;
      },
      reserveVisualAnalysisBudget: (env: Env, reservationInput: { researchJobId: string }) => {
        const db = env.DB as ReturnType<typeof workflowStatusDb>;
        const result = input.visualReservationResults?.shift() ?? { ok: false };
        db.reserveVisualAnalysisBudget(env, reservationInput);
        return result;
      },
      reserveVisualExtractionBudget: (env: Env, reservationInput: { researchJobId: string }) => {
        const db = env.DB as ReturnType<typeof workflowStatusDb>;
        const result = input.extractionReservationResults?.shift() ?? { ok: false };
        db.reserveVisualExtractionBudget(env, reservationInput);
        return result;
      },
      visualExtractionReservationUsd: async () => 0.8,
      releaseDeepAnalysisBudgetReservation: async (db: ReturnType<typeof workflowStatusDb>, researchJobId: string) => {
        if (input.releaseError) throw input.releaseError;
        return db.releaseDeepAnalysisBudgetReservation(db, researchJobId);
      },
      releaseAnalysisBudgetReservation: async (db: ReturnType<typeof workflowStatusDb>, researchJobId: string) => {
        if (input.releaseError) throw input.releaseError;
        return db.releaseAnalysisBudgetReservation(db, researchJobId);
      },
    }));
  }
  vi.doMock("../../../worker/src/analysis/deepAnalyze", () => ({
    analyzeDeepSource: async (env: Env, sourceId: string, profile: "precision" | "maximum") => {
      const db = env.DB as ReturnType<typeof workflowStatusDb>;
      db.analyzeDeepSource(env, sourceId, profile);
      if (input.analyzeDeepSource) return input.analyzeDeepSource(env, sourceId, profile);
      if (input.analysisError) throw input.analysisError;
      return input.analysisResults?.shift() ?? { analysisId: "analysis-default", model: "review-model", costUsd: 0.01 };
    },
  }));
  vi.doMock("../../../worker/src/visual/extraction/run", () => ({
    runVisualExtraction: async (_env: Env, _jobInput: {
      sourceId: string;
      sourceVersionId: string;
      extractionRunId?: string;
      visionBudget: {
        budgetReserved: boolean;
        reservationUsd: number;
      };
    }) => {
      if (input.visualExtractionRunner) return input.visualExtractionRunner(_env, _jobInput as never);
      const next = input.visualExtractionResults?.shift();
      if (!next) throw new Error("visual_extraction_missing_fixture");
      return next;
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
