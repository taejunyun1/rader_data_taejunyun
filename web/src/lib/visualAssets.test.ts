import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("visual extraction migration", () => {
  it("creates extraction tables and enforces status, active-run, temp-expiry, and candidate idempotency constraints", () => {
    const result = verifyVisualExtractionMigration();

    expect(result.foreignKeyCheck).toBe("");
    expect(result.invalidRunStatusError).toContain("CHECK");
    expect(result.invalidUnitStatusError).toContain("CHECK");
    expect(result.duplicateActiveRunError).toContain("UNIQUE");
    expect(result.recreatedRunCount).toBe(2);
    expect(result.expiredTempIndexSql).toContain("temp_r2_key");
    expect(result.duplicateCandidateError).toContain("UNIQUE");
    expect(result.recreatedCandidateCount).toBe(2);
  });

  it("stays compatible with Wrangler D1 migration execution", () => {
    const migrationSql = readFileSync(join(process.cwd(), "../worker/migrations/0018_visual_extraction_and_review.sql"), "utf8");

    expect(migrationSql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);
  });

  it("adds durable visual vision budget counters without transaction wrappers", () => {
    const migrationSql = readFileSync(join(process.cwd(), "../worker/migrations/0019_visual_extraction_vision_budget.sql"), "utf8");

    expect(migrationSql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);
    expect(migrationSql).toContain("vision_slots_used");
    expect(migrationSql).toContain("vision_attempted");
    expect(migrationSql).toContain("DEFAULT 80");
  });

  it("adds reservation identity binding without transaction wrappers", () => {
    const migrationSql = readFileSync(join(process.cwd(), "../worker/migrations/0020_visual_extraction_reservation_binding.sql"), "utf8");

    expect(migrationSql).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);
    expect(migrationSql).toContain("vision_reservation_id");
    expect(migrationSql).toContain("vision_reservation_job_id");
  });
});

describe("visual extraction vision budget", () => {
  it("blocks every model call when the workflow budget reservation is denied", async () => {
    const { createVisualExtractionVisionGate, VisualExtractionVisionBlockedError } = await import(
      "../../../worker/src/visual/extraction/visionBudget"
    );
    const modelCall = vi.fn().mockResolvedValue("should-not-run");
    const gate = createVisualExtractionVisionGate({ budgetReserved: false, reservationUsd: 0.8 });

    await expect(gate.execute(modelCall)).rejects.toMatchObject<Partial<VisualExtractionVisionBlockedError>>({
      reason: "monthly_budget_exhausted",
    });

    expect(modelCall).not.toHaveBeenCalled();
    expect(gate.snapshot()).toEqual({
      callLimit: 80,
      reservationUsd: 0.8,
      budgetReserved: false,
      budgetBlocked: true,
      attempted: 1,
      completed: 0,
      failed: 0,
      blocked: 1,
      capBlocked: 0,
    });
  });

  it("permits at most 80 extraction model calls and records the blocked overflow", async () => {
    const { createVisualExtractionVisionGate } = await import("../../../worker/src/visual/extraction/visionBudget");
    const gate = createVisualExtractionVisionGate({ budgetReserved: true, reservationUsd: 0.8 });
    const modelCall = vi.fn().mockResolvedValue("ok");

    for (let call = 0; call < 80; call += 1) {
      await expect(gate.execute(modelCall)).resolves.toBe("ok");
    }
    await expect(gate.execute(modelCall)).rejects.toMatchObject({ reason: "visual_extraction_call_limit" });

    expect(modelCall).toHaveBeenCalledTimes(80);
    expect(gate.snapshot()).toMatchObject({
      callLimit: 80,
      budgetReserved: true,
      budgetBlocked: false,
      attempted: 81,
      completed: 80,
      failed: 0,
      blocked: 1,
      capBlocked: 1,
    });
  });

  it("reconstructs the vision gate from the durable extraction run after a workflow restart", async () => {
    const { ExtractionStore, createVisualExtractionVisionPersistence } = await import(
      "../../../worker/src/visual/extraction/store"
    );
    const { createVisualExtractionVisionGate } = await import(
      "../../../worker/src/visual/extraction/visionBudget"
    );
    const db = createExtractionDb({
      reservations: [{ id: "reservation-1", researchJobId: "job-1", status: "RESERVED" }],
    });
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-restart",
      parentVersionId: "version-restart",
      originKind: "PDF_PAGE_CROP",
    });
    const persistence = createVisualExtractionVisionPersistence(db, run.id);
    await persistence.seed({ budgetReserved: true, reservationUsd: 0.8, reservationId: "reservation-1", researchJobId: "job-1" });
    const modelCall = vi.fn().mockResolvedValue("ok");

    const firstAttemptState = await persistence.load();
    const firstAttemptGate = createVisualExtractionVisionGate({
      persistence,
      initialState: firstAttemptState,
    });
    for (let call = 0; call < 40; call += 1) {
      await firstAttemptGate.execute(modelCall);
    }

    const reconstructedPersistence = createVisualExtractionVisionPersistence(db, run.id);
    const reconstructedGate = createVisualExtractionVisionGate({
      persistence: reconstructedPersistence,
      initialState: await reconstructedPersistence.load(),
    });
    for (let call = 0; call < 40; call += 1) {
      await reconstructedGate.execute(modelCall);
    }
    await expect(reconstructedGate.execute(modelCall)).rejects.toMatchObject({
      reason: "visual_extraction_call_limit",
    });
    await reconstructedGate.refresh();

    expect(modelCall).toHaveBeenCalledTimes(80);
    expect(reconstructedGate.snapshot()).toMatchObject({
      attempted: 81,
      completed: 80,
      failed: 0,
      blocked: 1,
      capBlocked: 1,
    });
    await expect(reconstructedPersistence.load()).resolves.toMatchObject({
      diagnostics: expect.objectContaining({ attempted: 81, completed: 80, blocked: 1, capBlocked: 1 }),
      slotsUsed: 80,
    });
  });

  it("does not let a denied retry reuse authorization or claim the 41st durable slot", async () => {
    const { ExtractionStore, createVisualExtractionVisionPersistence } = await import(
      "../../../worker/src/visual/extraction/store"
    );
    const { createVisualExtractionVisionGate } = await import(
      "../../../worker/src/visual/extraction/visionBudget"
    );
    const db = createExtractionDb({
      reservations: [{ id: "reservation-1", researchJobId: "job-1", status: "RESERVED" }],
    });
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-denied-retry",
      parentVersionId: "version-denied-retry",
      originKind: "PDF_PAGE_CROP",
    });
    const persistence = createVisualExtractionVisionPersistence(db, run.id);
    const seed = (input: {
      budgetReserved: boolean;
      reservationUsd: number;
      reservationId: string | null;
      researchJobId: string;
    }) => persistence.seed(input as never);
    await seed({ budgetReserved: true, reservationUsd: 0.8, reservationId: "reservation-1", researchJobId: "job-1" });
    await expect(persistence.load()).resolves.toMatchObject({
      diagnostics: expect.objectContaining({ callLimit: 80, budgetReserved: true }),
      slotsUsed: 0,
    });
    const modelCall = vi.fn().mockResolvedValue("ok");
    const firstAttemptGate = createVisualExtractionVisionGate({
      persistence,
      initialState: await persistence.load(),
    });
    for (let call = 0; call < 40; call += 1) {
      await firstAttemptGate.execute(modelCall);
    }

    await seed({ budgetReserved: false, reservationUsd: 0.8, reservationId: null, researchJobId: "job-2" });
    const deniedRetryPersistence = createVisualExtractionVisionPersistence(db, run.id);
    const deniedRetryState = await deniedRetryPersistence.load();
    expect(deniedRetryState.diagnostics.budgetReserved).toBe(false);
    expect(deniedRetryState.slotsUsed).toBe(40);
    const deniedRetryGate = createVisualExtractionVisionGate({
      persistence: deniedRetryPersistence,
      initialState: deniedRetryState,
    });

    await expect(deniedRetryGate.execute(modelCall)).rejects.toMatchObject({ reason: "monthly_budget_exhausted" });
    expect(modelCall).toHaveBeenCalledTimes(40);
    await expect(deniedRetryPersistence.load()).resolves.toMatchObject({
      diagnostics: expect.objectContaining({ attempted: 41, completed: 40, blocked: 1, capBlocked: 0 }),
      slotsUsed: 40,
    });
  });
});

describe("ExtractionStore", () => {
  it("preserves the declared PDF total when finishing a partial set of uploaded page units", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-85",
      originKind: "PDF_PAGE_CROP",
      now: "2026-08-26T01:00:00.000Z",
    });
    const persistedRun = db.state.runs.find((row) => row.id === run.id);
    if (!persistedRun) throw new Error("run_fixture_missing");
    persistedRun.totalUnits = 85;

    for (let page = 1; page <= 40; page += 1) {
      await ExtractionStore.recordUnit(db, { runId: run.id, unitNumber: page, candidateKey: `page-${page}` });
      await ExtractionStore.markUnitProcessed(db, {
        runId: run.id,
        unitNumber: page,
        candidateKey: `page-${page}`,
        status: "SUCCEEDED",
      });
    }

    const finished = await ExtractionStore.finishRun(db, {
      runId: run.id,
      counts: { selected: 40, review: 0, filtered: 0, unavailable: 0 },
    });

    expect(finished.totalUnits).toBe(85);
  });

  it("does not collapse earlier successful run counts when a retry reports only its current units", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb({
      runs: [{
        id: "run-cumulative",
        parentSourceId: "source-1",
        parentVersionId: "version-1",
        originKind: "PDF_PAGE_CROP",
        status: "PARTIAL",
        selectedCount: 3,
        reviewCount: 2,
        filteredCount: 4,
        unavailableCount: 1,
      }],
    });

    const finished = await ExtractionStore.finishRun(db, {
      runId: "run-cumulative",
      counts: { selected: 0, review: 1, filtered: 0, unavailable: 0 },
      status: "SUCCEEDED",
    });

    expect(finished).toMatchObject({
      selectedCount: 3,
      reviewCount: 2,
      filteredCount: 4,
      unavailableCount: 1,
    });
  });

  it("reuses an active run for the same source version and creates a new run when the active version changes", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();

    const first = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "PDF_PAGE_CROP",
      now: "2026-08-25T01:00:00.000Z",
    });
    const resumed = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "PDF_PAGE_CROP",
      now: "2026-08-25T01:01:00.000Z",
    });
    const nextVersion = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-2",
      originKind: "PDF_PAGE_CROP",
      now: "2026-08-25T01:02:00.000Z",
    });

    expect(resumed.id).toBe(first.id);
    expect(nextVersion.id).not.toBe(first.id);
    expect(db.state.runs.map((run) => run.parentVersionId)).toEqual(["version-1", "version-2"]);
  });

  it("recovers the canonical run and unit after concurrent-style duplicate insertion attempts", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb({
      simulateRunInsertRace: {
        parentSourceId: "source-1",
        parentVersionId: "version-1",
        originKind: "PDF_PAGE_CROP",
        canonicalId: "run-canonical",
        createdAt: "2026-08-25T01:00:00.000Z",
      },
      simulateUnitInsertRace: {
        runId: "run-canonical",
        unitNumber: 7,
        candidateKey: "candidate-7",
        canonicalId: "unit-canonical",
        createdAt: "2026-08-25T01:00:10.000Z",
      },
    });

    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "PDF_PAGE_CROP",
      now: "2026-08-25T01:00:00.000Z",
    });
    const unit = await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 7,
      candidateKey: "candidate-7",
      tempR2Key: "tmp/candidate-7.webp",
      createdAt: "2026-08-25T01:00:10.000Z",
    });

    expect(run.id).toBe("run-canonical");
    expect(unit.id).toBe("unit-canonical");
    expect(db.state.runs).toHaveLength(1);
    expect(db.state.units).toHaveLength(1);
  });

  it("keeps unit recording idempotent and finishes zero-result runs as succeeded with explicit counts", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "WEB_EMBED",
      now: "2026-08-25T02:00:00.000Z",
    });

    const first = await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "hero",
      tempR2Key: "tmp/hero.webp",
      createdAt: "2026-08-25T02:00:00.000Z",
    });
    const duplicate = await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "hero",
      tempR2Key: "tmp/hero.webp",
      createdAt: "2026-08-25T02:00:00.000Z",
    });

    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "detail",
      tempR2Key: "tmp/detail.webp",
      createdAt: "2026-08-25T02:00:30.000Z",
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "hero",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T02:01:00.000Z",
      width: 1200,
      height: 900,
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "detail",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T02:01:30.000Z",
      width: 640,
      height: 480,
    });

    const finished = await ExtractionStore.finishRun(db, {
      runId: run.id,
      counts: {
        selected: 0,
        review: 0,
        filtered: 1,
        unavailable: 1,
      },
      finishedAt: "2026-08-25T02:02:00.000Z",
    });

    expect(duplicate.id).toBe(first.id);
    expect(db.state.units).toHaveLength(2);
    expect(finished.status).toBe("SUCCEEDED");
    expect(finished.uploadedUnits).toBe(2);
    expect(finished.processedUnits).toBe(2);
    expect(finished.selectedCount).toBe(0);
    expect(finished.reviewCount).toBe(0);
    expect(finished.filteredCount).toBe(1);
    expect(finished.unavailableCount).toBe(1);
  });

  it("keeps processing units non-terminal and blocks succeeded completion while pending units remain", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "WEB_EMBED",
      now: "2026-08-25T02:30:00.000Z",
    });

    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      tempR2Key: "tmp/candidate-1.webp",
      createdAt: "2026-08-25T02:30:00.000Z",
    });
    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      tempR2Key: "tmp/candidate-2.webp",
      createdAt: "2026-08-25T02:30:10.000Z",
    });

    const processing = await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      status: "PROCESSING",
      processedAt: "2026-08-25T02:31:00.000Z",
    });
    const finished = await ExtractionStore.finishRun(db, {
      runId: run.id,
      counts: {
        selected: 0,
        review: 1,
        filtered: 0,
        unavailable: 0,
      },
      finishedAt: "2026-08-25T02:32:00.000Z",
    });

    expect(processing.processedAt).toBeNull();
    expect(finished.processedUnits).toBe(0);
    expect(finished.status).toBe("RUNNING");
    expect(finished.finishedAt).toBeNull();
  });

  it("reports partial success when some units fail and lists expired temp units", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "DISCOVERY_EMBED",
      now: "2026-08-25T03:00:00.000Z",
    });

    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      tempR2Key: "tmp/one.webp",
      createdAt: "2026-08-25T03:00:00.000Z",
    });
    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      tempR2Key: "tmp/two.webp",
      createdAt: "2026-08-25T03:00:10.000Z",
    });
    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 3,
      candidateKey: "candidate-3",
      tempR2Key: "tmp/three.webp",
      createdAt: "2026-08-25T03:00:20.000Z",
    });

    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T03:01:00.000Z",
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      status: "FAILED",
      processedAt: "2026-08-25T03:01:30.000Z",
      errorCode: "fetch_failed",
      error: "origin missing",
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 3,
      candidateKey: "candidate-3",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T03:01:45.000Z",
    });

    const finished = await ExtractionStore.finishRun(db, {
      runId: run.id,
      counts: {
        selected: 1,
        review: 1,
        filtered: 0,
        unavailable: 0,
      },
      finishedAt: "2026-08-25T03:02:00.000Z",
    });
    const expired = await ExtractionStore.listExpiredUnits(db, {
      olderThan: "2026-08-25T03:10:00.000Z",
    });

    expect(finished.status).toBe("PARTIAL");
    expect(expired.map((unit) => unit.candidateKey)).toEqual(["candidate-2"]);

  });

  it("recomputes cancel counters from current units instead of copying the stale run row", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "DISCOVERY_EMBED",
      now: "2026-08-25T03:00:00.000Z",
    });

    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      tempR2Key: "tmp/one.webp",
      createdAt: "2026-08-25T03:00:00.000Z",
    });
    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      tempR2Key: "tmp/two.webp",
      createdAt: "2026-08-25T03:00:10.000Z",
    });
    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 3,
      candidateKey: "candidate-3",
      tempR2Key: "tmp/three.webp",
      createdAt: "2026-08-25T03:00:20.000Z",
    });

    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T03:01:00.000Z",
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      status: "FAILED",
      processedAt: "2026-08-25T03:01:30.000Z",
      errorCode: "fetch_failed",
      error: "origin missing",
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 3,
      candidateKey: "candidate-3",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T03:01:45.000Z",
    });

    const cancelled = await ExtractionStore.cancelRun(db, {
      runId: run.id,
      errorCode: "user_cancelled",
      error: "cancelled from dashboard",
      cancelledAt: "2026-08-25T03:03:00.000Z",
    });

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.errorCode).toBe("user_cancelled");
    expect(cancelled.totalUnits).toBe(3);
    expect(cancelled.uploadedUnits).toBe(3);
    expect(cancelled.processedUnits).toBe(3);
  });

  it("marks deleted units with deleted_at, excludes them from uploaded counts, and allows succeeded completion after terminal units only", async () => {
    const { ExtractionStore } = await import("../../../worker/src/visual/extraction/store");
    const db = createExtractionDb();
    const run = await ExtractionStore.createOrResumeRun(db, {
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "DISCOVERY_EMBED",
      now: "2026-08-25T03:30:00.000Z",
    });

    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      tempR2Key: "tmp/candidate-1.webp",
      createdAt: "2026-08-25T03:30:00.000Z",
    });
    await ExtractionStore.recordUnit(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      tempR2Key: "tmp/candidate-2.webp",
      createdAt: "2026-08-25T03:30:10.000Z",
    });

    const deleted = await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 1,
      candidateKey: "candidate-1",
      status: "DELETED",
      processedAt: "2026-08-25T03:31:00.000Z",
    });
    await ExtractionStore.markUnitProcessed(db, {
      runId: run.id,
      unitNumber: 2,
      candidateKey: "candidate-2",
      status: "SUCCEEDED",
      processedAt: "2026-08-25T03:31:30.000Z",
    });

    const finished = await ExtractionStore.finishRun(db, {
      runId: run.id,
      counts: {
        selected: 1,
        review: 0,
        filtered: 0,
        unavailable: 0,
      },
      finishedAt: "2026-08-25T03:32:00.000Z",
    });

    expect(deleted.deletedAt).toBe("2026-08-25T03:31:00.000Z");
    expect(deleted.processedAt).toBe("2026-08-25T03:31:00.000Z");
    expect(finished.uploadedUnits).toBe(1);
    expect(finished.processedUnits).toBe(2);
    expect(finished.status).toBe("SUCCEEDED");
  });
});

describe("visual asset detail mapping", () => {
  it("maps bbox, rights basis, analysis history, and relations into the detail DTO", async () => {
    const { toVisualAssetDetail } = await import("../../../worker/src/visual/store");

    const detail = toVisualAssetDetail(
      {
        id: "asset-1",
        parentSourceId: "source-1",
        parentVersionId: "version-1",
        originKind: "PDF_PAGE_CROP",
        sourceUrl: "https://example.com/figure-1",
        pageNumber: 4,
        figureLabel: "Figure 1",
        bboxJson: "{\"x\":0.12,\"y\":0.2,\"width\":0.4,\"height\":0.5,\"page\":4}",
        candidateKey: "page-4-figure-1",
        caption: "A camera obscura diagram",
        nearbyText: "The diagram appears beside the opening argument.",
        assetRole: "REFERENCE",
        visualKind: "DIAGRAM",
        selectionStatus: "REVIEW",
        selectionReason: "needs confirmation",
        rightsStatus: "PERMITTED",
        rightsBasis: "Author email permission",
        rightsReviewedAt: "2026-08-25T04:00:00.000Z",
        assignmentStatus: "ASSIGNED",
        storageState: "LINK_ONLY",
        pendingStorageState: null,
        processingStatus: "READY",
        lastError: null,
        contentHash: "hash-1",
        perceptualHash: "phash-1",
        perceptualHashMethod: "IMAGES_RGBA_DHASH_V1",
        createdAt: "2026-08-25T04:00:00.000Z",
        updatedAt: "2026-08-25T04:01:00.000Z",
        deletedAt: null,
      },
      {
        id: "analysis-auto",
        payload: { summary: "auto" },
        provenanceClass: "INTERPRETATION",
        confidence: 0.7,
        reviewStatus: "PENDING",
        modelId: "vision-low",
        promptVersion: "v1",
        createdAt: "2026-08-25T04:02:00.000Z",
      },
      {
        id: "analysis-user",
        payload: { summary: "verified" },
        provenanceClass: "INTERPRETATION",
        confidence: null,
        reviewStatus: "EDITED",
        modelId: null,
        promptVersion: null,
        createdAt: "2026-08-25T04:03:00.000Z",
      },
      [
        {
          id: "relation-1",
          relationKind: "DUPLICATE_OF",
          createdBy: "SYSTEM",
          description: "near duplicate",
          toVisualAssetId: "asset-2",
          relatedSourceId: null,
          relatedThreadId: null,
          createdAt: "2026-08-25T04:04:00.000Z",
        },
      ],
    );

    expect(detail.bbox).toEqual({
      x: 0.12,
      y: 0.2,
      width: 0.4,
      height: 0.5,
      page: 4,
    });
    expect(detail.nearbyText).toContain("opening argument");
    expect(detail.rightsBasis).toBe("Author email permission");
    expect(detail.autoSuggestion?.id).toBe("analysis-auto");
    expect(detail.userVerified?.id).toBe("analysis-user");
    expect(detail.relations).toEqual([
      expect.objectContaining({
        id: "relation-1",
        relationKind: "DUPLICATE_OF",
      }),
    ]);
  });
});

describe("visual extraction filter decisions", () => {
  it("marks tracker and repeated-logo candidates as decorative before duplicate checks", async () => {
    const { filterVisualCandidate } = await import("../../../worker/src/visual/extraction/filter");

    const decision = filterVisualCandidate({
      contentHash: "hash-1",
      perceptualHash: "f0f0f0f0f0f0f0f0",
      caption: "Museum logo",
      nearbyText: null,
      signals: ["tracker_pixel", "repeated_logo"],
      existingAssets: [
        { assetId: "asset-duplicate", contentHash: "hash-1", perceptualHash: "f0f0f0f0f0f0f0f0" },
      ],
    });

    expect(decision.selectionStatus).toBe("DECORATIVE");
    expect(decision.selectionReason).toBe("visual-filter-v1:decorative_signal");
    expect(decision.duplicateOf).toBeNull();
  });

  it("returns DUPLICATE with a DUPLICATE_OF relation for exact or near duplicates", async () => {
    const { filterVisualCandidate } = await import("../../../worker/src/visual/extraction/filter");

    const exact = filterVisualCandidate({
      contentHash: "hash-1",
      perceptualHash: "0123456789abcdef",
      caption: "Figure 1. Installation view",
      nearbyText: "Detailed discussion beside the figure.",
      signals: [],
      existingAssets: [
        { assetId: "asset-exact", contentHash: "hash-1", perceptualHash: "fedcba9876543210" },
      ],
    });
    const near = filterVisualCandidate({
      contentHash: "hash-2",
      perceptualHash: "0123456789abcdee",
      caption: "Figure 2. Installation detail",
      nearbyText: "Close reading of the detail crop.",
      signals: [],
      existingAssets: [
        { assetId: "asset-near", contentHash: "hash-9", perceptualHash: "0123456789abcdef" },
      ],
    });

    expect(exact).toMatchObject({
      selectionStatus: "DUPLICATE",
      selectionReason: "visual-filter-v1:duplicate_exact",
      duplicateOf: {
        relationKind: "DUPLICATE_OF",
        toVisualAssetId: "asset-exact",
      },
    });
    expect(near).toMatchObject({
      selectionStatus: "DUPLICATE",
      selectionReason: "visual-filter-v1:duplicate_near",
      duplicateOf: {
        relationKind: "DUPLICATE_OF",
        toVisualAssetId: "asset-near",
      },
    });
  });

  it("downgrades thin-context candidates to REVIEW and maps fetch failures to UNAVAILABLE", async () => {
    const { filterVisualCandidate, unavailableVisualDecision } = await import("../../../worker/src/visual/extraction/filter");

    const review = filterVisualCandidate({
      contentHash: "hash-3",
      perceptualHash: "aaaaaaaaaaaaaaaa",
      caption: null,
      nearbyText: "label",
      signals: ["review_small_context"],
      existingAssets: [],
    });
    const unavailable = unavailableVisualDecision("IMAGE_URL_BLOCKED");

    expect(review.selectionStatus).toBe("REVIEW");
    expect(review.selectionReason).toBe("visual-filter-v1:needs_context_review");
    expect(unavailable.selectionStatus).toBe("UNAVAILABLE");
    expect(unavailable.selectionReason).toBe("visual-filter-v1:unavailable_image_url_blocked");
  });
});

describe("rights-first LINK_ONLY drafts", () => {
  it("creates a metadata-only ORIGINAL version for UNKNOWN rights without persistent bytes", async () => {
    const { buildLinkOnlyVisualDraft } = await import("../../../worker/src/visual/extraction/filter");

    const draft = buildLinkOnlyVisualDraft({
      now: "2026-08-25T05:00:00.000Z",
      idFactory: (() => {
        const ids = ["asset-link", "version-link"];
        return () => ids.shift() ?? "missing-id";
      })(),
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "WEB_EMBED",
      candidateKey: "candidate-link",
      sourceUrl: "https://example.com/image.jpg",
      finalUrl: "https://cdn.example.com/image.jpg",
      figureLabel: "Figure 1",
      caption: "Figure 1. Installation view",
      nearbyText: "The article discusses the installation in detail.",
      contentType: "image/jpeg",
      byteSize: 2048,
      contentHash: "hash-link",
      rightsStatus: "UNKNOWN",
      rightsBasis: null,
      decision: {
        selectionStatus: "REVIEW",
        selectionReason: "visual-filter-v1:needs_context_review",
        ruleVersion: "visual-filter-v1",
        duplicateOf: null,
      },
    });

    expect(draft.persistBytes).toBe(false);
    expect(draft.asset).toMatchObject({
      id: "asset-link",
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "WEB_EMBED",
      sourceUrl: "https://example.com/image.jpg",
      candidateKey: "candidate-link",
      figureLabel: "Figure 1",
      caption: "Figure 1. Installation view",
      nearbyText: "The article discusses the installation in detail.",
      selectionStatus: "REVIEW",
      selectionReason: "visual-filter-v1:needs_context_review",
      rightsStatus: "UNKNOWN",
      rightsBasis: null,
      rightsReviewedAt: null,
      storageState: "LINK_ONLY",
      processingStatus: "READY",
      contentHash: "hash-link",
    });
    expect(draft.originalVersion).toMatchObject({
      id: "version-link",
      visualAssetId: "asset-link",
      variant: "ORIGINAL",
      r2Key: null,
      mimeType: "image/jpeg",
      byteSize: 2048,
      contentHash: "hash-link",
    });
    expect(draft.provenance.finalUrl).toBe("https://cdn.example.com/image.jpg");
    expect(draft.relations).toEqual([]);
  });

  it("preserves duplicate provenance as a relation without deleting or merging the asset", async () => {
    const { buildLinkOnlyVisualDraft } = await import("../../../worker/src/visual/extraction/filter");

    const draft = buildLinkOnlyVisualDraft({
      now: "2026-08-25T05:10:00.000Z",
      idFactory: (() => {
        const ids = ["asset-dup", "version-dup", "relation-dup"];
        return () => ids.shift() ?? "missing-id";
      })(),
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "DISCOVERY_EMBED",
      candidateKey: "candidate-dup",
      sourceUrl: "https://example.com/dup.jpg",
      finalUrl: "https://cdn.example.com/dup.jpg",
      figureLabel: null,
      caption: "Repeated figure",
      nearbyText: "Repeated figure in a slightly cropped layout.",
      contentType: "image/jpeg",
      byteSize: 4096,
      contentHash: "hash-dup",
      rightsStatus: "PUBLIC_LINK",
      rightsBasis: "source page link only",
      decision: {
        selectionStatus: "DUPLICATE",
        selectionReason: "visual-filter-v1:duplicate_near",
        ruleVersion: "visual-filter-v1",
        duplicateOf: {
          relationKind: "DUPLICATE_OF",
          toVisualAssetId: "asset-existing",
          description: "near duplicate via dHash<=6",
        },
      },
    });

    expect(draft.asset.deletedAt).toBeNull();
    expect(draft.relations).toEqual([
      expect.objectContaining({
        relationKind: "DUPLICATE_OF",
        toVisualAssetId: "asset-existing",
        description: "near duplicate via dHash<=6",
      }),
    ]);
  });
});

describe("pdf visual candidate parsing", () => {
  it("rejects invalid, overlapping, and decorative PDF page candidates before they reach transform", async () => {
    const { parsePdfPageCandidates } = await import("../../../worker/src/visual/extraction/pdf");

    const result = parsePdfPageCandidates([
      {
        bbox: { x: -0.05, y: 0.1, width: 0.4, height: 0.4 },
        visualKind: "PHOTO",
        figureLabel: "Figure 0",
        caption: "Out of bounds",
        reason: "candidate",
        confidence: 0.7,
      },
      {
        bbox: { x: 0.2, y: 0.2, width: 0, height: 0.5 },
        visualKind: "ARTWORK",
        figureLabel: "Figure 0b",
        caption: "Zero width",
        reason: "candidate",
        confidence: 0.72,
      },
      {
        bbox: { x: 0.06, y: 0.02, width: 0.16, height: 0.08 },
        visualKind: "DECORATIVE",
        figureLabel: null,
        caption: "Header logo",
        reason: "header logo",
        confidence: 0.84,
      },
      {
        bbox: { x: 0.12, y: 0.18, width: 0.44, height: 0.46 },
        visualKind: "INSTALLATION",
        figureLabel: "Figure 1",
        caption: "Installation overview",
        reason: "main figure",
        confidence: 0.93,
      },
      {
        bbox: { x: 0.121, y: 0.181, width: 0.439, height: 0.459 },
        visualKind: "PHOTO",
        figureLabel: "Figure 1a",
        caption: "Near-duplicate crop",
        reason: "duplicate figure",
        confidence: 0.89,
      },
      {
        bbox: { x: 0.02, y: 0.9, width: 0.96, height: 0.08 },
        visualKind: "DECORATIVE",
        figureLabel: null,
        caption: "Repeated background band",
        reason: "background",
        confidence: 0.66,
      },
    ]);

    expect(result.accepted).toEqual([
      expect.objectContaining({
        visualKind: "INSTALLATION",
        figureLabel: "Figure 1",
        caption: "Installation overview",
      }),
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual(expect.arrayContaining([
      "bbox_out_of_range",
      "bbox_zero_area",
      "decorative_header_footer",
      "bbox_duplicate_overlap",
      "decorative_repeated_background",
    ]));
  });
});

describe("pdf visual crop and common filtering", () => {
  it("crops normalized PDF bboxes into temporary WebP bytes before downstream use", async () => {
    const { cropVisualBytes } = await import("../../../worker/src/visual/transform");
    const transform = vi.fn().mockReturnValue({
      output: vi.fn().mockResolvedValue({
        response: () => new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "image/webp" } }),
      }),
    });
    const input = vi.fn().mockReturnValue({ transform });
    const env = {
      IMAGES: {
        info: vi.fn().mockResolvedValue({ format: "image/webp", width: 1000, height: 800 }),
        input,
      },
    } as unknown as Env;

    const result = await cropVisualBytes(env, new Uint8Array([1, 2, 3]).buffer, {
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    });

    expect(transform).toHaveBeenCalledWith({
      trim: { top: 160, right: 600, bottom: 320, left: 100 },
    });
    expect(result.bytes).toEqual(new Uint8Array([9, 8, 7]).buffer);
    expect(result.mimeType).toBe("image/webp");
    expect(result.width).toBe(300);
    expect(result.height).toBe(320);
  });

  it("routes PDF crop hashes through the common filter and preserves duplicate relation decisions", async () => {
    const { decidePdfVisualCandidate } = await import("../../../worker/src/visual/extraction/run");
    const { buildLinkOnlyVisualDraft } = await import("../../../worker/src/visual/extraction/filter");
    const decision = decidePdfVisualCandidate({
      pageNumber: 3,
      candidate: {
        bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
        visualKind: "PHOTO",
        figureLabel: "Figure 3",
        caption: "Figure 3. Repeated installation view",
        reason: "main figure",
        confidence: 0.94,
      },
      contentHash: "crop-sha256",
      perceptualHash: "0123456789abcdee",
      existingAssets: [{ assetId: "asset-existing", contentHash: "other-hash", perceptualHash: "0123456789abcdef" }],
    });
    const draft = buildLinkOnlyVisualDraft({
      now: "2026-08-26T01:00:00.000Z",
      idFactory: (() => {
        const ids = ["asset-pdf", "version-pdf", "relation-pdf"];
        return () => ids.shift() ?? "missing-id";
      })(),
      parentSourceId: "source-1",
      parentVersionId: "version-1",
      originKind: "PDF_PAGE_CROP",
      candidateKey: "page-3-figure-3-0",
      sourceUrl: "source:source-1",
      finalUrl: "source:source-1",
      figureLabel: "Figure 3",
      caption: "Figure 3. Repeated installation view",
      nearbyText: "page 3 | Figure 3 | Repeated installation view | main figure",
      pageNumber: 3,
      bboxJson: JSON.stringify({ x: 0.1, y: 0.2, width: 0.3, height: 0.4, page: 3 }),
      contentType: "image/webp",
      byteSize: 3,
      contentHash: "crop-sha256",
      rightsStatus: "UNKNOWN",
      rightsBasis: "pdf_rights_unknown_requires_link_only",
      decision,
    });

    expect(decision).toMatchObject({
      selectionStatus: "DUPLICATE",
      selectionReason: "visual-filter-v1:duplicate_near",
      duplicateOf: { relationKind: "DUPLICATE_OF", toVisualAssetId: "asset-existing" },
    });
    expect(draft.asset.selectionStatus).toBe("DUPLICATE");
    expect(draft.relations).toEqual([
      expect.objectContaining({ relationKind: "DUPLICATE_OF", toVisualAssetId: "asset-existing" }),
    ]);
  });
});

describe("pdf resume and duplicate transform gates", () => {
  it("rebuilds cumulative retry counts and outcomes from persisted assets and units", async () => {
    const { summarizePersistedExtraction } = await import("../../../worker/src/visual/extraction/run");

    expect(summarizePersistedExtraction({
      assets: [
        { selectionStatus: "SELECTED", selectionReason: "visual-filter-v1:selected_contextual_match", rightsStatus: "PERSONAL" },
        { selectionStatus: "REVIEW", selectionReason: "visual-filter-v1:needs_context_review", rightsStatus: "UNKNOWN" },
        { selectionStatus: "DUPLICATE", selectionReason: "visual-filter-v1:duplicate_exact", rightsStatus: "UNKNOWN" },
      ],
      units: [
        { status: "SUCCEEDED" },
        { status: "FAILED" },
        { status: "DELETED" },
      ],
    })).toEqual({
      counts: { selected: 1, review: 1, filtered: 1, unavailable: 1 },
      outcomeCounts: { duplicateExact: 1, duplicateNear: 0, rightsGated: 2 },
    });
  });

  it("retains earlier successful diagnostics while adding retry vision usage", async () => {
    const { mergeVisualExtractionDiagnostics } = await import("../../../worker/src/visual/extraction/run");
    const prior = {
      sourceKind: "PDF" as const,
      limits: { htmlCandidates: 40, htmlFetch: 12, pdfPages: 40 },
      blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 12 },
      vision: {
        callLimit: 80,
        reservationUsd: 0.8,
        budgetReserved: true,
        budgetBlocked: false,
        attempted: 30,
        completed: 29,
        failed: 1,
        blocked: 0,
        capBlocked: 0,
      },
    };
    const retry = {
      ...prior,
      blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 0 },
      vision: {
        ...prior.vision,
        attempted: 2,
        completed: 1,
        failed: 0,
        blocked: 1,
        capBlocked: 1,
      },
    };

    expect(mergeVisualExtractionDiagnostics(prior, retry)).toMatchObject({
      blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 12 },
      vision: { attempted: 32, completed: 30, failed: 1, blocked: 1, capBlocked: 1 },
    });
  });

  it("retries failed or processing units, skips terminal success, and retains failed-page retry inputs", async () => {
    const {
      shouldProcessPdfExtractionUnit,
      shouldDeletePdfPageTemp,
    } = await import("../../../worker/src/visual/extraction/run");

    expect(shouldProcessPdfExtractionUnit("SUCCEEDED")).toBe(false);
    expect(shouldProcessPdfExtractionUnit("FAILED")).toBe(true);
    expect(shouldProcessPdfExtractionUnit("PROCESSING")).toBe(true);
    expect(shouldProcessPdfExtractionUnit("DELETED")).toBe(false);
    expect(shouldDeletePdfPageTemp("SUCCEEDED")).toBe(true);
    expect(shouldDeletePdfPageTemp("FAILED")).toBe(false);
  });

  it("marks an inline-deleted PDF temp unit as DELETED so cleanup does not recount it", async () => {
    const { deletePdfExtractionUnitTemp } = await import("../../../worker/src/visual/extraction/run");
    const { cleanupExpiredVisualExtractionTemps } = await import("../../../worker/src/visual/cleanup");
    const db = createExtractionDb({
      runs: [{
        id: "run-inline-cleanup",
        parentSourceId: "source-1",
        parentVersionId: "version-1",
        originKind: "PDF_PAGE_CROP",
        status: "SUCCEEDED",
        totalUnits: 1,
        uploadedUnits: 1,
        processedUnits: 1,
        selectedCount: 1,
        reviewCount: 0,
        filteredCount: 0,
        unavailableCount: 0,
        errorCode: null,
        error: null,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T01:00:00.000Z",
        finishedAt: "2026-08-24T01:00:00.000Z",
      }],
      units: [{
        id: "unit-inline-cleanup",
        runId: "run-inline-cleanup",
        unitNumber: 1,
        candidateKey: "page-1",
        status: "SUCCEEDED",
        tempR2Key: "visual-temp/run-inline-cleanup/page-1.webp",
        width: 1200,
        height: 900,
        contentHash: "page-hash",
        errorCode: null,
        error: null,
        createdAt: "2026-08-24T00:00:00.000Z",
        processedAt: "2026-08-24T01:00:00.000Z",
        deletedAt: null,
      }],
    });
    const deleteTemp = vi.fn().mockResolvedValue(undefined);
    const env = { DB: db, ORIGINALS: { delete: deleteTemp } } as unknown as Env;

    await deletePdfExtractionUnitTemp(env, {
      runId: "run-inline-cleanup",
      unitNumber: 1,
      candidateKey: "page-1",
      tempR2Key: "visual-temp/run-inline-cleanup/page-1.webp",
      deletedAt: "2026-08-26T01:00:00.000Z",
    });

    expect(deleteTemp).toHaveBeenCalledWith("visual-temp/run-inline-cleanup/page-1.webp");
    expect(db.state.units[0]).toMatchObject({ status: "DELETED", deletedAt: "2026-08-26T01:00:00.000Z" });
    await expect(cleanupExpiredVisualExtractionTemps(env, { now: "2026-08-27T01:00:00.000Z" })).resolves.toEqual({
      scanned: 0,
      deleted: 0,
      cleanupFailures: 0,
      skippedActiveOrRecent: 0,
    });
    expect(deleteTemp).toHaveBeenCalledTimes(1);
  });

  it("leaves the successful unit retryable when inline R2 temp deletion fails", async () => {
    const { deletePdfExtractionUnitTemp } = await import("../../../worker/src/visual/extraction/run");
    const { cleanupExpiredVisualExtractionTemps } = await import("../../../worker/src/visual/cleanup");
    const db = createExtractionDb({
      runs: [{
        id: "run-inline-retry",
        parentSourceId: "source-1",
        parentVersionId: "version-1",
        originKind: "PDF_PAGE_CROP",
        status: "SUCCEEDED",
        totalUnits: 1,
        uploadedUnits: 1,
        processedUnits: 1,
        selectedCount: 1,
        reviewCount: 0,
        filteredCount: 0,
        unavailableCount: 0,
        errorCode: null,
        error: null,
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T01:00:00.000Z",
        finishedAt: "2026-08-24T01:00:00.000Z",
      }],
      units: [{
        id: "unit-inline-retry",
        runId: "run-inline-retry",
        unitNumber: 1,
        candidateKey: "page-1",
        status: "SUCCEEDED",
        tempR2Key: "visual-temp/run-inline-retry/page-1.webp",
        width: 1200,
        height: 900,
        contentHash: "page-hash",
        errorCode: null,
        error: null,
        createdAt: "2026-08-24T00:00:00.000Z",
        processedAt: "2026-08-24T01:00:00.000Z",
        deletedAt: null,
      }],
    });
    const deleteTemp = vi.fn()
      .mockRejectedValueOnce(new Error("simulated_r2_delete_failure"))
      .mockResolvedValueOnce(undefined);
    const env = { DB: db, ORIGINALS: { delete: deleteTemp } } as unknown as Env;

    await expect(deletePdfExtractionUnitTemp(env, {
      runId: "run-inline-retry",
      unitNumber: 1,
      candidateKey: "page-1",
      tempR2Key: "visual-temp/run-inline-retry/page-1.webp",
      deletedAt: "2026-08-26T01:00:00.000Z",
    })).rejects.toThrow("simulated_r2_delete_failure");

    expect(db.state.units[0]).toMatchObject({
      status: "SUCCEEDED",
      tempR2Key: "visual-temp/run-inline-retry/page-1.webp",
      deletedAt: null,
    });

    await expect(cleanupExpiredVisualExtractionTemps(env, { now: "2026-08-26T01:00:00.000Z" })).resolves.toEqual({
      scanned: 1,
      deleted: 1,
      cleanupFailures: 0,
      skippedActiveOrRecent: 0,
    });
    expect(db.state.units[0]?.deletedAt).toBe("2026-08-26T01:00:00.000Z");
    expect(deleteTemp).toHaveBeenCalledTimes(2);
  });

  it("allows permitted or personal PDF crops across the transform boundary only for SELECTED or REVIEW", async () => {
    const { shouldPersistPdfTransform } = await import("../../../worker/src/visual/extraction/run");

    expect(shouldPersistPdfTransform("SELECTED")).toBe(true);
    expect(shouldPersistPdfTransform("REVIEW")).toBe(true);
    expect(shouldPersistPdfTransform("DUPLICATE")).toBe(false);
    expect(shouldPersistPdfTransform("DECORATIVE")).toBe(false);
    expect(shouldPersistPdfTransform("UNAVAILABLE")).toBe(false);
  });

  it("selects only failed or non-terminal HTML units when retrying an existing extraction run", async () => {
    const { selectHtmlRetryCandidates, shouldProcessHtmlExtractionUnit } = await import("../../../worker/src/visual/extraction/run");

    expect(shouldProcessHtmlExtractionUnit("SUCCEEDED")).toBe(false);
    expect(shouldProcessHtmlExtractionUnit("FAILED")).toBe(true);
    expect(shouldProcessHtmlExtractionUnit("PROCESSING")).toBe(true);
    expect(shouldProcessHtmlExtractionUnit("DELETED")).toBe(false);

    const candidates = Array.from({ length: 13 }, (_, index) => ({
      candidateKey: `candidate-${index + 1}`,
    }));
    const retryable = selectHtmlRetryCandidates(candidates, [
      { candidateKey: "candidate-1", status: "SUCCEEDED" },
      { candidateKey: "candidate-13", status: "FAILED" },
    ]);

    expect(retryable).toEqual([{ candidateKey: "candidate-13" }]);
  });
});

describe("visual extraction runner", () => {
  it("defaults ordinary uploaded PDFs to UNKNOWN LINK_ONLY rights without reviewed evidence", async () => {
    const module = await import("../../../worker/src/visual/extraction/run") as typeof import("../../../worker/src/visual/extraction/run") & {
      pdfRightsForSource(origin: string | null): { rightsStatus: string; rightsBasis: string | null; storageState: string };
    };

    expect(module.pdfRightsForSource("upload:pdf")).toEqual({
      rightsStatus: "UNKNOWN",
      rightsBasis: null,
      storageState: "LINK_ONLY",
    });
    expect(module.pdfRightsForSource("url:https://example.com/paper.pdf")).toEqual({
      rightsStatus: "UNKNOWN",
      rightsBasis: null,
      storageState: "LINK_ONLY",
    });
    expect(module.pdfRightsForSource("homepage:project")).toEqual({
      rightsStatus: "UNKNOWN",
      rightsBasis: null,
      storageState: "LINK_ONLY",
    });
  });

  it("routes HTML versions through the HTML pipeline and preserves run-level diagnostics", async () => {
    const { runVisualExtraction } = await import("../../../worker/src/visual/extraction/run");
    const loadSource = vi.fn().mockResolvedValue({
      sourceId: "source-1",
      sourceVersionId: "version-html",
      inputFormat: "URL_HTML",
      extractionMethod: "HTML_STATIC",
      origin: "url",
    });
    const runHtmlExtraction = vi.fn().mockResolvedValue({
      extractionRunId: "run-html",
      status: "PARTIAL",
      counts: { selected: 1, review: 2, filtered: 9, unavailable: 3 },
      diagnostics: {
        sourceKind: "HTML",
        limits: { htmlCandidates: 40, htmlFetch: 12, pdfPages: 40 },
        blocked: { htmlCandidates: 18, htmlFetch: 6, pdfPages: 0 },
      },
    });
    const runPdfExtraction = vi.fn();

    const result = await runVisualExtraction({} as Env, {
      sourceId: "source-1",
      sourceVersionId: "version-html",
    }, {
      loadSource,
      runHtmlExtraction,
      runPdfExtraction,
    });

    expect(loadSource).toHaveBeenCalledWith(
      {} as Env,
      expect.objectContaining({ sourceId: "source-1", sourceVersionId: "version-html" }),
    );
    expect(runHtmlExtraction).toHaveBeenCalledTimes(1);
    expect(runPdfExtraction).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      extractionRunId: "run-html",
      status: "PARTIAL",
      counts: { unavailable: 3 },
      diagnostics: {
        sourceKind: "HTML",
        blocked: { htmlCandidates: 18, htmlFetch: 6, pdfPages: 0 },
      },
    });
  });

  it("routes PDF versions through the PDF pipeline with the existing extraction run id", async () => {
    const { runVisualExtraction } = await import("../../../worker/src/visual/extraction/run");
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const loadSource = vi.fn().mockResolvedValue({
      sourceId: "source-1",
      sourceVersionId: "version-pdf",
      inputFormat: "PDF_TEXT",
      extractionMethod: "BROWSER_PDFJS",
      origin: "upload:pdf",
    });
    const runHtmlExtraction = vi.fn();
    const runPdfExtraction = vi.fn().mockResolvedValue({
      extractionRunId: "run-pdf",
      status: "SUCCEEDED",
      counts: { selected: 2, review: 1, filtered: 4, unavailable: 0 },
      diagnostics: {
        sourceKind: "PDF",
        limits: { htmlCandidates: 40, htmlFetch: 12, pdfPages: 40 },
        blocked: { htmlCandidates: 0, htmlFetch: 0, pdfPages: 12 },
      },
    });

    const result = await runVisualExtraction({} as Env, {
      sourceId: "source-1",
      sourceVersionId: "version-pdf",
      extractionRunId: "run-pdf",
      onProgress,
    }, {
      loadSource,
      runHtmlExtraction,
      runPdfExtraction,
    });

    expect(runHtmlExtraction).not.toHaveBeenCalled();
    expect(runPdfExtraction).toHaveBeenCalledWith(
      {} as Env,
      expect.objectContaining({
        sourceId: "source-1",
        sourceVersionId: "version-pdf",
        extractionRunId: "run-pdf",
        onProgress,
      }),
      expect.objectContaining({
        inputFormat: "PDF_TEXT",
        origin: "upload:pdf",
      }),
    );
    expect(result.diagnostics.blocked.pdfPages).toBe(12);
  });
});

describe("visual extraction cleanup", () => {
  it("deletes only 24-hour-old PDF temp objects from terminal runs and leaves active or recent runs untouched", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-cleanup", activeVersionId: "version-cleanup" });
    fixture.insertSourceVersion({ id: "version-cleanup", sourceId: "source-cleanup", version: 1 });
    fixture.insertExtractionRun({
      id: "run-stale",
      parentSourceId: "source-cleanup",
      parentVersionId: "version-cleanup",
      originKind: "PDF_PAGE_CROP",
      status: "FAILED",
      totalUnits: 1,
      uploadedUnits: 1,
      processedUnits: 1,
      selectedCount: 0,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 1,
      createdAt: "2026-08-24T08:00:00.000Z",
      updatedAt: "2026-08-24T08:10:00.000Z",
      finishedAt: "2026-08-24T08:10:00.000Z",
    });
    fixture.insertExtractionUnit({
      id: "unit-stale",
      runId: "run-stale",
      unitNumber: 1,
      candidateKey: "page-1",
      status: "FAILED",
      tempR2Key: "visual-temp/run-stale/page-1.webp",
      createdAt: "2026-08-24T08:00:00.000Z",
      processedAt: "2026-08-24T08:09:00.000Z",
    });
    fixture.insertExtractionRun({
      id: "run-recent",
      parentSourceId: "source-cleanup",
      parentVersionId: "version-cleanup",
      originKind: "PDF_PAGE_CROP",
      status: "SUCCEEDED",
      totalUnits: 1,
      uploadedUnits: 1,
      processedUnits: 1,
      selectedCount: 1,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 0,
      createdAt: "2026-08-25T09:00:00.000Z",
      updatedAt: "2026-08-25T09:10:00.000Z",
      finishedAt: "2026-08-25T09:10:00.000Z",
    });
    fixture.insertExtractionUnit({
      id: "unit-recent",
      runId: "run-recent",
      unitNumber: 1,
      candidateKey: "page-1",
      status: "SUCCEEDED",
      tempR2Key: "visual-temp/run-recent/page-1.webp",
      createdAt: "2026-08-25T09:00:00.000Z",
      processedAt: "2026-08-25T09:05:00.000Z",
    });
    fixture.insertExtractionRun({
      id: "run-active",
      parentSourceId: "source-cleanup",
      parentVersionId: "version-cleanup",
      originKind: "PDF_PAGE_CROP",
      status: "RUNNING",
      totalUnits: 1,
      uploadedUnits: 1,
      processedUnits: 0,
      selectedCount: 0,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 0,
      createdAt: "2026-08-24T06:00:00.000Z",
      updatedAt: "2026-08-25T11:30:00.000Z",
      finishedAt: null,
    });
    fixture.insertExtractionUnit({
      id: "unit-active",
      runId: "run-active",
      unitNumber: 1,
      candidateKey: "page-1",
      status: "UPLOADED",
      tempR2Key: "visual-temp/run-active/page-1.webp",
      createdAt: "2026-08-24T06:00:00.000Z",
    });

    const { cleanupExpiredVisualExtractionTemps } = await import("../../../worker/src/visual/cleanup");
    const result = await cleanupExpiredVisualExtractionTemps(fixture.env, { now: "2026-08-25T12:00:00.000Z" });

    expect(result).toEqual({
      scanned: 3,
      deleted: 1,
      cleanupFailures: 0,
      skippedActiveOrRecent: 2,
    });
    expect(fixture.deleteCalls).toEqual(["visual-temp/run-stale/page-1.webp"]);
    expect(fixture.extractionUnitRow("unit-stale")?.deleted_at).toBe("2026-08-25T12:00:00.000Z");
    expect(fixture.extractionUnitRow("unit-recent")?.deleted_at).toBeNull();
    expect(fixture.extractionUnitRow("unit-active")?.deleted_at).toBeNull();
  });

  it("reports cleanup failures without marking the temp unit deleted", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-cleanup-failure", activeVersionId: "version-cleanup-failure" });
    fixture.insertSourceVersion({ id: "version-cleanup-failure", sourceId: "source-cleanup-failure", version: 1 });
    fixture.insertExtractionRun({
      id: "run-cleanup-failure",
      parentSourceId: "source-cleanup-failure",
      parentVersionId: "version-cleanup-failure",
      originKind: "PDF_PAGE_CROP",
      status: "PARTIAL",
      totalUnits: 1,
      uploadedUnits: 1,
      processedUnits: 1,
      selectedCount: 0,
      reviewCount: 0,
      filteredCount: 0,
      unavailableCount: 1,
      createdAt: "2026-08-24T05:00:00.000Z",
      updatedAt: "2026-08-24T05:10:00.000Z",
      finishedAt: "2026-08-24T05:10:00.000Z",
    });
    fixture.insertExtractionUnit({
      id: "unit-cleanup-failure",
      runId: "run-cleanup-failure",
      unitNumber: 1,
      candidateKey: "page-1",
      status: "FAILED",
      tempR2Key: "visual-temp/run-cleanup-failure/page-1.webp",
      createdAt: "2026-08-24T05:00:00.000Z",
      processedAt: "2026-08-24T05:09:00.000Z",
    });
    fixture.failNextR2Delete();

    const { cleanupExpiredVisualExtractionTemps } = await import("../../../worker/src/visual/cleanup");
    const result = await cleanupExpiredVisualExtractionTemps(fixture.env, { now: "2026-08-25T12:00:00.000Z" });

    expect(result).toEqual({
      scanned: 1,
      deleted: 0,
      cleanupFailures: 1,
      skippedActiveOrRecent: 0,
    });
    expect(fixture.extractionUnitRow("unit-cleanup-failure")?.deleted_at).toBeNull();
  });
});

describe("visual asset routes", () => {
  it("records explicit personal-upload rights evidence only at the personal image upload boundary", async () => {
    const fixture = createVisualAssetRouteFixture();
    const { createPersonalVisual } = await import("../../../worker/src/visual/store");

    await createPersonalVisual(fixture.env, {
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0x00]).buffer,
      filename: "personal.jpg",
      contentType: "image/jpeg",
      parentSourceId: null,
    });

    const row = fixture.sqlite.prepare("SELECT rights_status, rights_basis, rights_reviewed_at, storage_state FROM visual_assets LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      rights_status: "PERSONAL",
      rights_basis: "user_personal_upload",
      storage_state: "ARCHIVAL",
    });
    expect(String(row.rights_reviewed_at ?? "")).toMatch(/^2026-|^20\d\d-/);
  });

  it("returns bbox, nearby text, rights basis, auto suggestion, latest user verified, relations, and extraction run in the detail payload", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({
      id: "asset-1",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      originKind: "PDF_PAGE_CROP",
      sourceUrl: "https://example.com/figure-1",
      pageNumber: 4,
      figureLabel: "Figure 1",
      bboxJson: JSON.stringify({ x: 0.14, y: 0.18, width: 0.4, height: 0.44, page: 4 }),
      caption: "Figure 1. Camera obscura diagram",
      nearbyText: "The diagram appears beside the opening claim.",
      rightsStatus: "PERMITTED",
      rightsBasis: "Author email permission",
      rightsReviewedAt: "2026-08-25T04:00:00.000Z",
    });
    fixture.insertAsset({ id: "asset-2", parentSourceId: "source-1", parentVersionId: "version-source-1", sourceUrl: "https://example.com/figure-2" });
    fixture.insertAssetVersion({ id: "asset-1-original", visualAssetId: "asset-1", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-1/original.webp" });
    fixture.insertAssetVersion({ id: "asset-1-capsule", visualAssetId: "asset-1", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-1/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-auto",
      visualAssetId: "asset-1",
      visualVersionId: "asset-1-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("auto"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T04:02:00.000Z",
    });
    fixture.insertAnalysis({
      id: "analysis-user-1",
      visualAssetId: "asset-1",
      visualVersionId: "asset-1-capsule",
      analysisType: "USER_VERIFIED",
      parentAnalysisId: "analysis-auto",
      payload: validVisualAnalysisPayload("verified-1"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T04:03:00.000Z",
    });
    fixture.insertAnalysis({
      id: "analysis-user-2",
      visualAssetId: "asset-1",
      visualVersionId: "asset-1-capsule",
      analysisType: "USER_VERIFIED",
      parentAnalysisId: "analysis-user-1",
      payload: validVisualAnalysisPayload("verified-2"),
      reviewStatus: "EDITED",
      createdAt: "2026-08-25T04:04:00.000Z",
    });
    fixture.insertRelation({
      id: "relation-1",
      fromVisualAssetId: "asset-1",
      toVisualAssetId: "asset-2",
      relationKind: "DUPLICATE_OF",
      createdBy: "SYSTEM",
      description: "near duplicate",
      createdAt: "2026-08-25T04:05:00.000Z",
    });
    fixture.insertExtractionRun({
      id: "run-1",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      originKind: "PDF_PAGE_CROP",
      status: "PARTIAL",
      totalUnits: 3,
      uploadedUnits: 3,
      processedUnits: 2,
      selectedCount: 1,
      reviewCount: 1,
      filteredCount: 0,
      unavailableCount: 1,
      createdAt: "2026-08-25T04:06:00.000Z",
      updatedAt: "2026-08-25T04:06:30.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-1", undefined, fixture.env);

    expect(response.status).toBe(200);
    const data = await response.json() as { asset: Record<string, unknown> };
    expect(data.asset).toMatchObject({
      id: "asset-1",
      sourceUrl: "https://example.com/figure-1",
      rightsBasis: "Author email permission",
      nearbyText: "The diagram appears beside the opening claim.",
      autoSuggestion: expect.objectContaining({ id: "analysis-auto" }),
      userVerified: expect.objectContaining({ id: "analysis-user-2" }),
      relations: [expect.objectContaining({ id: "relation-1", relationKind: "DUPLICATE_OF" })],
      extractionRun: expect.objectContaining({ id: "run-1", status: "PARTIAL", unavailableCount: 1 }),
    });
    expect(data.asset.bbox).toEqual({
      x: 0.14,
      y: 0.18,
      width: 0.4,
      height: 0.44,
      page: 4,
    });
  });

  it("resolves LINK_ONLY ORIGINAL analysis for detail and edit without exposing stored bytes", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-link", activeVersionId: "version-link" });
    fixture.insertSourceVersion({ id: "version-link", sourceId: "source-link", version: 1 });
    fixture.insertAsset({
      id: "asset-link-only",
      parentSourceId: "source-link",
      parentVersionId: "version-link",
      originKind: "WEB_EMBED",
      sourceUrl: "https://example.com/remote-figure.webp",
      storageState: "LINK_ONLY",
      rightsStatus: "UNKNOWN",
      rightsBasis: "external_image_requires_rights_review",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({
      id: "asset-link-only-original",
      visualAssetId: "asset-link-only",
      version: 1,
      variant: "ORIGINAL",
      r2Key: null,
      mimeType: "image/webp",
    });
    fixture.insertAnalysis({
      id: "analysis-link-only-auto",
      visualAssetId: "asset-link-only",
      visualVersionId: "asset-link-only-original",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("link-only-auto"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T04:20:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const detailResponse = await visualAssets.request("/asset-link-only", undefined, fixture.env);

    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as { asset: Record<string, unknown> };
    expect(detail.asset).toMatchObject({
      storageState: "LINK_ONLY",
      capsuleVersionId: null,
      thumbnailUrl: null,
      autoSuggestion: expect.objectContaining({ id: "analysis-link-only-auto" }),
    });

    const editedPayload = validVisualAnalysisPayload("link-only-edited");
    const editResponse = await visualAssets.request("/asset-link-only/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", payload: editedPayload }),
    }, fixture.env);

    expect(editResponse.status).toBe(200);
    const editedDetail = await editResponse.json() as { asset: Record<string, unknown> };
    expect(editedDetail.asset).toMatchObject({
      capsuleVersionId: null,
      thumbnailUrl: null,
      analysis: expect.objectContaining({ payload: editedPayload }),
    });
    expect(fixture.analysisRowsFor("asset-link-only")).toContainEqual(expect.objectContaining({
      analysis_type: "USER_VERIFIED",
      visual_version_id: "asset-link-only-original",
      parent_analysis_id: "analysis-link-only-auto",
      payload_json: JSON.stringify(editedPayload),
    }));

    const contentResponse = await visualAssets.request("/asset-link-only/content?variant=ORIGINAL", undefined, fixture.env);
    expect(contentResponse.status).toBe(404);
  });

  it("accepts an auto suggestion by creating a new USER_VERIFIED row without mutating the auto suggestion row", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({ id: "asset-accept", parentSourceId: "source-1", parentVersionId: "version-source-1" });
    fixture.insertAssetVersion({ id: "asset-accept-capsule", visualAssetId: "asset-accept", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-accept/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-auto",
      visualAssetId: "asset-accept",
      visualVersionId: "asset-accept-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("auto-accept"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T05:00:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-accept/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "accept" }),
    }, fixture.env);

    expect(response.status).toBe(200);
    const analyses = fixture.analysisRowsFor("asset-accept");
    expect(analyses).toHaveLength(2);
    expect(analyses.find((row) => row.id === "analysis-auto")).toMatchObject({
      analysis_type: "AUTO_SUGGESTION",
      review_status: "PENDING",
      payload_json: JSON.stringify(validVisualAnalysisPayload("auto-accept")),
      parent_analysis_id: null,
    });
    const verified = analyses.find((row) => row.analysis_type === "USER_VERIFIED");
    expect(verified).toMatchObject({
      parent_analysis_id: "analysis-auto",
      review_status: "ACCEPTED",
      payload_json: JSON.stringify(validVisualAnalysisPayload("auto-accept")),
    });
  });

  it("edits a suggestion by appending a new USER_VERIFIED row to the immediately prior verified base", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({ id: "asset-edit", parentSourceId: "source-1", parentVersionId: "version-source-1" });
    fixture.insertAssetVersion({ id: "asset-edit-capsule", visualAssetId: "asset-edit", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-edit/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-auto",
      visualAssetId: "asset-edit",
      visualVersionId: "asset-edit-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("auto-edit"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T05:10:00.000Z",
    });
    fixture.insertAnalysis({
      id: "analysis-user-1",
      visualAssetId: "asset-edit",
      visualVersionId: "asset-edit-capsule",
      analysisType: "USER_VERIFIED",
      parentAnalysisId: "analysis-auto",
      payload: validVisualAnalysisPayload("verified-edit-1"),
      reviewStatus: "EDITED",
      createdAt: "2026-08-25T05:11:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const editedPayload = validVisualAnalysisPayload("verified-edit-2");
    const response = await visualAssets.request("/asset-edit/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", payload: editedPayload }),
    }, fixture.env);

    expect(response.status).toBe(200);
    const analyses = fixture.analysisRowsFor("asset-edit").filter((row) => row.analysis_type === "USER_VERIFIED");
    expect(analyses).toHaveLength(2);
    expect(analyses.at(-1)).toMatchObject({
      parent_analysis_id: "analysis-user-1",
      visual_version_id: "asset-edit-capsule",
      review_status: "EDITED",
      payload_json: JSON.stringify(editedPayload),
    });
  });

  it("chains repeated edits through each immediately prior USER_VERIFIED row", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({ id: "asset-repeated-edit", parentSourceId: "source-1", parentVersionId: "version-source-1" });
    fixture.insertAssetVersion({ id: "asset-repeated-edit-capsule", visualAssetId: "asset-repeated-edit", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-repeated-edit/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-repeated-auto",
      visualAssetId: "asset-repeated-edit",
      visualVersionId: "asset-repeated-edit-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("repeated-auto"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T05:20:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const firstPayload = validVisualAnalysisPayload("repeated-edit-1");
    const firstResponse = await visualAssets.request("/asset-repeated-edit/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", payload: firstPayload }),
    }, fixture.env);
    expect(firstResponse.status).toBe(200);

    const firstVerified = fixture.analysisRowsFor("asset-repeated-edit").find((row) => row.analysis_type === "USER_VERIFIED");
    expect(firstVerified).toMatchObject({
      parent_analysis_id: "analysis-repeated-auto",
      visual_version_id: "asset-repeated-edit-capsule",
      payload_json: JSON.stringify(firstPayload),
    });

    const secondPayload = validVisualAnalysisPayload("repeated-edit-2");
    const secondResponse = await visualAssets.request("/asset-repeated-edit/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", payload: secondPayload }),
    }, fixture.env);
    expect(secondResponse.status).toBe(200);

    const verifiedRows = fixture.analysisRowsFor("asset-repeated-edit").filter((row) => row.analysis_type === "USER_VERIFIED");
    expect(verifiedRows).toHaveLength(2);
    expect(verifiedRows.at(-1)).toMatchObject({
      parent_analysis_id: firstVerified?.id,
      visual_version_id: "asset-repeated-edit-capsule",
      payload_json: JSON.stringify(secondPayload),
    });
  });

  it("anchors re-analysis review and storage retention to the current capsule, not stale verified history", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({
      id: "asset-reanalysis",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      storageState: "ARCHIVAL",
      rightsStatus: "PERMITTED",
      rightsBasis: "contract",
      rightsReviewedAt: "2026-08-25T05:30:00.000Z",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({ id: "asset-reanalysis-original", visualAssetId: "asset-reanalysis", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-reanalysis/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-reanalysis-old-capsule", visualAssetId: "asset-reanalysis", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-reanalysis/old-capsule.webp" });
    fixture.insertAssetVersion({ id: "asset-reanalysis-current-capsule", visualAssetId: "asset-reanalysis", version: 2, variant: "CAPSULE", r2Key: "visuals/asset-reanalysis/current-capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-old-auto",
      visualAssetId: "asset-reanalysis",
      visualVersionId: "asset-reanalysis-old-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("old-auto"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T05:31:00.000Z",
    });
    fixture.insertAnalysis({
      id: "analysis-old-user",
      visualAssetId: "asset-reanalysis",
      visualVersionId: "asset-reanalysis-old-capsule",
      analysisType: "USER_VERIFIED",
      parentAnalysisId: "analysis-old-auto",
      payload: validVisualAnalysisPayload("old-user"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T05:32:00.000Z",
    });
    fixture.insertAnalysis({
      id: "analysis-current-auto",
      visualAssetId: "asset-reanalysis",
      visualVersionId: "asset-reanalysis-current-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("current-auto"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T05:33:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const blocked = await visualAssets.request("/asset-reanalysis/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    }, fixture.env);
    expect(blocked.status).toBe(409);

    const review = await visualAssets.request("/asset-reanalysis/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", payload: validVisualAnalysisPayload("current-user") }),
    }, fixture.env);
    expect(review.status).toBe(200);

    const analyses = fixture.analysisRowsFor("asset-reanalysis");
    expect(analyses.find((row) => row.id === "analysis-old-user")).toBeDefined();
    expect(analyses.find((row) => row.analysis_type === "USER_VERIFIED" && row.visual_version_id === "asset-reanalysis-current-capsule")).toMatchObject({
      parent_analysis_id: "analysis-current-auto",
      payload_json: JSON.stringify(validVisualAnalysisPayload("current-user")),
    });

    const transitioned = await visualAssets.request("/asset-reanalysis/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    }, fixture.env);
    expect(transitioned.status).toBe(200);
    expect(fixture.assetRow("asset-reanalysis")).toMatchObject({ storage_state: "CAPSULE", pending_storage_state: null });
  });

  it("dismisses only the auto suggestion review state and preserves the asset plus prior analysis history", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({ id: "asset-dismiss", parentSourceId: "source-1", parentVersionId: "version-source-1" });
    fixture.insertAssetVersion({ id: "asset-dismiss-capsule", visualAssetId: "asset-dismiss", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-dismiss/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-auto",
      visualAssetId: "asset-dismiss",
      visualVersionId: "asset-dismiss-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("auto-dismiss"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T05:20:00.000Z",
    });
    fixture.insertAnalysis({
      id: "analysis-user-1",
      visualAssetId: "asset-dismiss",
      visualVersionId: "asset-dismiss-capsule",
      analysisType: "USER_VERIFIED",
      parentAnalysisId: "analysis-auto",
      payload: validVisualAnalysisPayload("verified-dismiss"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T05:21:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-dismiss/analysis", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    }, fixture.env);

    expect(response.status).toBe(200);
    expect(fixture.assetRow("asset-dismiss")).toMatchObject({
      id: "asset-dismiss",
      selection_status: "REVIEW",
    });
    const analyses = fixture.analysisRowsFor("asset-dismiss");
    expect(analyses).toHaveLength(2);
    expect(analyses.find((row) => row.id === "analysis-auto")?.review_status).toBe("DISMISSED");
    expect(analyses.find((row) => row.id === "analysis-user-1")?.review_status).toBe("ACCEPTED");
  });

  it("updates assignment atomically from the target source active version and rejects sources without an active version", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-old", activeVersionId: "version-old" });
    fixture.insertSourceVersion({ id: "version-old", sourceId: "source-old", version: 1 });
    fixture.insertSource({ id: "source-new", activeVersionId: "version-new" });
    fixture.insertSourceVersion({ id: "version-new", sourceId: "source-new", version: 2 });
    fixture.insertSource({ id: "source-empty", activeVersionId: null });
    fixture.insertAsset({ id: "asset-assign", parentSourceId: null, parentVersionId: null, assignmentStatus: "UNASSIGNED", originKind: "PERSONAL_UPLOAD" });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const missingVersion = await visualAssets.request("/asset-assign/assignment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-empty" }),
    }, fixture.env);
    expect(missingVersion.status).toBe(409);

    fixture.insertSource({ id: "source-other", activeVersionId: null });
    fixture.insertSource({ id: "source-cross", activeVersionId: "version-owned-by-other" });
    fixture.insertSourceVersion({ id: "version-owned-by-other", sourceId: "source-other", version: 1 });
    const crossSourceActive = await visualAssets.request("/asset-assign/assignment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-cross" }),
    }, fixture.env);
    expect(crossSourceActive.status).toBe(409);
    expect(fixture.assetRow("asset-assign")).toMatchObject({
      parent_source_id: null,
      parent_version_id: null,
      assignment_status: "UNASSIGNED",
    });

    fixture.insertSource({ id: "source-stale", activeVersionId: "version-stale" });
    fixture.insertSourceVersion({ id: "version-stale", sourceId: "source-stale", version: 1 });
    fixture.insertSourceVersion({ id: "version-current", sourceId: "source-stale", version: 2 });
    const staleExpected = await visualAssets.request("/asset-assign/assignment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-stale", sourceVersionId: "version-current" }),
    }, fixture.env);
    expect(staleExpected.status).toBe(409);
    expect(fixture.assetRow("asset-assign")).toMatchObject({
      parent_source_id: null,
      parent_version_id: null,
      assignment_status: "UNASSIGNED",
    });

    fixture.sqlite.prepare("UPDATE sources SET active_version_id = 'version-current' WHERE id = 'source-stale'").run();
    const currentExpected = await visualAssets.request("/asset-assign/assignment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-stale", sourceVersionId: "version-current" }),
    }, fixture.env);
    expect(currentExpected.status).toBe(200);
    expect(fixture.assetRow("asset-assign")).toMatchObject({
      parent_source_id: "source-stale",
      parent_version_id: "version-current",
      assignment_status: "ASSIGNED",
    });

    const response = await visualAssets.request("/asset-assign/assignment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-new" }),
    }, fixture.env);

    expect(response.status).toBe(409);
    expect(fixture.assetRow("asset-assign")).toMatchObject({
      parent_source_id: "source-stale",
      parent_version_id: "version-current",
      assignment_status: "ASSIGNED",
    });
  });

  it("atomically rejects non-personal, parented, and already-assigned targets while allowing a verified personal asset", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-target", activeVersionId: "version-target" });
    fixture.insertSourceVersion({ id: "version-target", sourceId: "source-target", version: 1 });
    fixture.insertAsset({
      id: "asset-extracted",
      originKind: "WEB_EMBED",
      assignmentStatus: "UNASSIGNED",
      parentSourceId: null,
      parentVersionId: null,
    });
    fixture.insertAsset({
      id: "asset-parented",
      originKind: "PERSONAL_UPLOAD",
      assignmentStatus: "UNASSIGNED",
      parentSourceId: "source-target",
      parentVersionId: "version-target",
    });
    fixture.insertAsset({
      id: "asset-analyzed",
      originKind: "PERSONAL_UPLOAD",
      assignmentStatus: "UNASSIGNED",
      parentSourceId: null,
      parentVersionId: null,
    });
    fixture.insertAssetVersion({
      id: "asset-analyzed-original",
      visualAssetId: "asset-analyzed",
      version: 1,
      variant: "ORIGINAL",
      r2Key: "visuals/asset-analyzed/original.jpg",
    });
    fixture.insertAnalysis({
      id: "analysis-assignment-guard",
      visualAssetId: "asset-analyzed",
      visualVersionId: "asset-analyzed-original",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("assignment-guard"),
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    for (const assetId of ["asset-extracted", "asset-parented"]) {
      const response = await visualAssets.request(`/${assetId}/assignment`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: "source-target" }),
      }, fixture.env);
      expect(response.status).toBe(409);
    }

    const analyzedResponse = await visualAssets.request("/asset-analyzed/assignment", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "source-target", sourceVersionId: "version-target" }),
    }, fixture.env);
    expect(analyzedResponse.status).toBe(200);

    expect(fixture.assetRow("asset-extracted")).toMatchObject({ parent_source_id: null, assignment_status: "UNASSIGNED" });
    expect(fixture.assetRow("asset-parented")).toMatchObject({ parent_source_id: "source-target", assignment_status: "UNASSIGNED" });
    expect(fixture.assetRow("asset-analyzed")).toMatchObject({ parent_source_id: "source-target", parent_version_id: "version-target", assignment_status: "ASSIGNED" });
  });

  it("recovers decorative or duplicate assets without erasing the original automated decision audit", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({
      id: "asset-recover",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      selectionStatus: "DUPLICATE",
      selectionReason: "visual-filter-v1:duplicate_exact",
      originKind: "WEB_EMBED",
    });
    fixture.insertAsset({
      id: "asset-existing",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      originKind: "WEB_EMBED",
    });
    fixture.insertRelation({
      id: "relation-duplicate",
      fromVisualAssetId: "asset-recover",
      toVisualAssetId: "asset-existing",
      relationKind: "DUPLICATE_OF",
      createdBy: "SYSTEM",
      description: "자동 중복 판정",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-recover/selection", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectionStatus: "REVIEW" }),
    }, fixture.env);

    expect(response.status).toBe(200);
    expect(fixture.assetRow("asset-recover")).toMatchObject({
      selection_status: "REVIEW",
    });
    const relations = fixture.relationRowsFor("asset-recover");
    expect(relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "relation-duplicate",
        relation_kind: "DUPLICATE_OF",
        description: "자동 중복 판정",
      }),
      expect.objectContaining({
        relation_kind: "SELECTION_OVERRIDE",
        created_by: "USER",
        description: expect.stringContaining("visual-filter-v1:duplicate_exact"),
      }),
    ]));
  });

  it("requires a non-empty basis for PERSONAL or PERMITTED rights and records the rights review timestamp", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });
    fixture.insertAsset({
      id: "asset-rights",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      rightsStatus: "UNKNOWN",
      rightsBasis: null,
      rightsReviewedAt: null,
      isPersonalWork: 0,
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const invalid = await visualAssets.request("/asset-rights/rights", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rightsStatus: "PERMITTED", rightsBasis: "   " }),
    }, fixture.env);
    expect(invalid.status).toBe(400);

    const invalidPersonal = await visualAssets.request("/asset-rights/rights", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rightsStatus: "PERSONAL", rightsBasis: "   " }),
    }, fixture.env);
    expect(invalidPersonal.status).toBe(400);

    const response = await visualAssets.request("/asset-rights/rights", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rightsStatus: "PERMITTED", rightsBasis: "Author email permission" }),
    }, fixture.env);

    expect(response.status).toBe(200);
    expect(fixture.assetRow("asset-rights")).toMatchObject({
      rights_status: "PERMITTED",
      rights_basis: "Author email permission",
      is_personal_work: 0,
    });
    expect(String(fixture.assetRow("asset-rights")?.rights_reviewed_at ?? "")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("reuses the active transform retry job on repeated clicks so duplicate work is not created", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertAsset({ id: "asset-retry-transform", processingStatus: "FAILED", selectionStatus: "REVIEW" });
    fixture.insertAssetVersion({ id: "asset-retry-transform-original", visualAssetId: "asset-retry-transform", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-retry-transform/original.jpg" });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const first = await visualAssets.request("/asset-retry-transform/retry", { method: "POST" }, fixture.env);
    const second = await visualAssets.request("/asset-retry-transform/retry", { method: "POST" }, fixture.env);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstData = await first.json() as { reused: boolean; job: { id: string; kind: string } };
    const secondData = await second.json() as { reused: boolean; job: { id: string; kind: string } };
    expect(firstData.job.kind).toBe("VISUAL_TRANSFORM");
    expect(secondData.job.id).toBe(firstData.job.id);
    expect(secondData.reused).toBe(true);
    expect(fixture.workflowCreate).toHaveBeenCalledTimes(1);
    expect(fixture.jobRows()).toHaveLength(1);
  });

  it("retries analysis when a capsule exists without analysis and reuses the parent extraction run when only extraction recovery is available", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertSource({ id: "source-1", activeVersionId: "version-source-1" });
    fixture.insertSourceVersion({ id: "version-source-1", sourceId: "source-1", version: 1 });

    fixture.insertAsset({
      id: "asset-retry-analysis",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      processingStatus: "READY",
      originKind: "PERSONAL_UPLOAD",
    });
    fixture.insertAssetVersion({ id: "asset-retry-analysis-original", visualAssetId: "asset-retry-analysis", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-retry-analysis/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-retry-analysis-capsule", visualAssetId: "asset-retry-analysis", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-retry-analysis/capsule.webp" });

    fixture.insertAsset({
      id: "asset-retry-extraction",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      processingStatus: "READY",
      originKind: "WEB_EMBED",
      selectionStatus: "UNAVAILABLE",
    });
    fixture.insertAssetVersion({ id: "asset-retry-extraction-original", visualAssetId: "asset-retry-extraction", version: 1, variant: "ORIGINAL", r2Key: null });
    fixture.insertExtractionRun({
      id: "run-recover",
      parentSourceId: "source-1",
      parentVersionId: "version-source-1",
      originKind: "WEB_EMBED",
      status: "FAILED",
      totalUnits: 4,
      uploadedUnits: 4,
      processedUnits: 4,
      selectedCount: 1,
      reviewCount: 1,
      filteredCount: 1,
      unavailableCount: 1,
      createdAt: "2026-08-25T06:10:00.000Z",
      updatedAt: "2026-08-25T06:10:30.000Z",
      finishedAt: "2026-08-25T06:11:00.000Z",
    });
    fixture.insertExtractionUnit({
      id: "unit-failed",
      runId: "run-recover",
      unitNumber: 2,
      candidateKey: "candidate-2",
      status: "FAILED",
      createdAt: "2026-08-25T06:10:10.000Z",
      processedAt: "2026-08-25T06:10:40.000Z",
      tempR2Key: "visual-temp/run-recover/page-2.webp",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const analysisRetry = await visualAssets.request("/asset-retry-analysis/retry", { method: "POST" }, fixture.env);
    const extractionRetry = await visualAssets.request("/asset-retry-extraction/retry", { method: "POST" }, fixture.env);

    expect(analysisRetry.status).toBe(202);
    expect(extractionRetry.status).toBe(202);
    const jobs = fixture.jobRows();
    expect(jobs.map((row) => row.kind)).toEqual(expect.arrayContaining(["VISUAL_ANALYSIS", "VISUAL_EXTRACTION"]));
    const extractionJob = jobs.find((row) => row.kind === "VISUAL_EXTRACTION");
    expect(extractionJob?.input_json).toContain("\"extractionRunId\":\"run-recover\"");
  });

  it("requires a verified analysis and a capsule before transitioning storage and records the operation journal", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertAsset({
      id: "asset-transition",
      storageState: "ARCHIVAL",
      pendingStorageState: null,
      processingStatus: "READY",
      rightsStatus: "PERMITTED",
      rightsBasis: "contract",
      rightsReviewedAt: "2026-08-25T06:30:00.000Z",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({ id: "asset-transition-original", visualAssetId: "asset-transition", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-transition/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-transition-capsule", visualAssetId: "asset-transition", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-transition/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-auto",
      visualAssetId: "asset-transition",
      visualVersionId: "asset-transition-capsule",
      analysisType: "AUTO_SUGGESTION",
      payload: validVisualAnalysisPayload("transition-auto"),
      reviewStatus: "PENDING",
      createdAt: "2026-08-25T06:31:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const blocked = await visualAssets.request("/asset-transition/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    }, fixture.env);
    expect(blocked.status).toBe(409);

    fixture.insertAnalysis({
      id: "analysis-user",
      visualAssetId: "asset-transition",
      visualVersionId: "asset-transition-capsule",
      analysisType: "USER_VERIFIED",
      parentAnalysisId: "analysis-auto",
      payload: validVisualAnalysisPayload("transition-user"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T06:32:00.000Z",
    });

    const response = await visualAssets.request("/asset-transition/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    }, fixture.env);

    expect(response.status).toBe(200);
    expect(fixture.deleteCalls).toEqual(["visuals/asset-transition/original.jpg"]);
    expect(fixture.assetRow("asset-transition")).toMatchObject({
      storage_state: "CAPSULE",
      pending_storage_state: null,
    });
    expect(fixture.assetVersionRow("asset-transition-original")?.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(fixture.operationRowsFor("asset-transition")).toEqual([
      expect.objectContaining({
        operation_kind: "DELETE_ORIGINAL",
        from_state: "ARCHIVAL",
        to_state: "CAPSULE",
        status: "SUCCEEDED",
      }),
    ]);
  });

  it("keeps a recoverable operation marker when DB finalization fails after R2 deletion", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertAsset({
      id: "asset-transition-failure",
      storageState: "ARCHIVAL",
      pendingStorageState: null,
      processingStatus: "READY",
      rightsStatus: "PERMITTED",
      rightsBasis: "contract",
      rightsReviewedAt: "2026-08-25T06:40:00.000Z",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({ id: "asset-transition-failure-original", visualAssetId: "asset-transition-failure", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-transition-failure/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-transition-failure-capsule", visualAssetId: "asset-transition-failure", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-transition-failure/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-transition-failure-user",
      visualAssetId: "asset-transition-failure",
      visualVersionId: "asset-transition-failure-capsule",
      analysisType: "USER_VERIFIED",
      payload: validVisualAnalysisPayload("transition-failure-user"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T06:41:00.000Z",
    });
    fixture.failNextBatchAfterR2Delete();

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-transition-failure/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    }, fixture.env);

    expect(response.status).toBe(500);
    expect(fixture.deleteCalls).toEqual(["visuals/asset-transition-failure/original.jpg"]);
    expect(fixture.assetRow("asset-transition-failure")).toMatchObject({
      storage_state: "ARCHIVAL",
      pending_storage_state: "CAPSULE",
    });
    expect(fixture.assetVersionRow("asset-transition-failure-original")?.deleted_at).toBeNull();
    expect(fixture.operationRowsFor("asset-transition-failure")).toEqual([
      expect.objectContaining({
        operation_kind: "DELETE_ORIGINAL",
        status: "FAILED",
        error: expect.stringContaining("finalize"),
      }),
    ]);
  });

  it("requires a second confirmation before deleting the capsule for a TEXT_ONLY transition", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertAsset({
      id: "asset-text-only",
      storageState: "CAPSULE",
      processingStatus: "READY",
      rightsStatus: "PERMITTED",
      rightsBasis: "contract",
      rightsReviewedAt: "2026-08-25T07:00:00.000Z",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({ id: "asset-text-only-original", visualAssetId: "asset-text-only", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-text-only/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-text-only-capsule", visualAssetId: "asset-text-only", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-text-only/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-text-only-user",
      visualAssetId: "asset-text-only",
      visualVersionId: "asset-text-only-capsule",
      analysisType: "USER_VERIFIED",
      payload: validVisualAnalysisPayload("text-only-user"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T07:01:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const blocked = await visualAssets.request("/asset-text-only/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "TEXT_ONLY", confirmation: "DELETE_CAPSULE" }),
    }, fixture.env);
    expect(blocked.status).toBe(400);
    await expect(blocked.json()).resolves.toEqual({ error: "storage_transition_second_confirmation_required" });
    expect(fixture.deleteCalls).toEqual([]);

    const response = await visualAssets.request("/asset-text-only/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "TEXT_ONLY", confirmation: "DELETE_CAPSULE", secondConfirmation: "TEXT_ONLY" }),
    }, fixture.env);

    expect(response.status).toBe(200);
    expect(fixture.deleteCalls).toEqual(["visuals/asset-text-only/capsule.webp"]);
    expect(fixture.assetRow("asset-text-only")).toMatchObject({
      storage_state: "TEXT_ONLY",
      pending_storage_state: null,
    });
    expect(fixture.assetVersionRow("asset-text-only-capsule")?.deleted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("rejects storage transitions for externally rights-gated assets even if legacy bytes still exist", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertAsset({
      id: "asset-rights-gated",
      storageState: "CAPSULE",
      processingStatus: "READY",
      rightsStatus: "PUBLIC_LINK",
      rightsBasis: "external_image_requires_link_only",
      rightsReviewedAt: "2026-08-25T07:10:00.000Z",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({ id: "asset-rights-gated-original", visualAssetId: "asset-rights-gated", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-rights-gated/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-rights-gated-capsule", visualAssetId: "asset-rights-gated", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-rights-gated/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-rights-gated-user",
      visualAssetId: "asset-rights-gated",
      visualVersionId: "asset-rights-gated-capsule",
      analysisType: "USER_VERIFIED",
      payload: validVisualAnalysisPayload("rights-gated-user"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T07:11:00.000Z",
    });

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-rights-gated/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "TEXT_ONLY", confirmation: "DELETE_CAPSULE", secondConfirmation: "TEXT_ONLY" }),
    }, fixture.env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "storage_transition_rights_invalid" });
    expect(fixture.deleteCalls).toEqual([]);
  });

  it("keeps the asset state unchanged and records a FAILED operation when the R2 delete itself fails", async () => {
    const fixture = createVisualAssetRouteFixture();
    fixture.insertAsset({
      id: "asset-transition-delete-failure",
      storageState: "ARCHIVAL",
      pendingStorageState: null,
      processingStatus: "READY",
      rightsStatus: "PERMITTED",
      rightsBasis: "contract",
      rightsReviewedAt: "2026-08-25T07:20:00.000Z",
      isPersonalWork: 0,
    });
    fixture.insertAssetVersion({ id: "asset-transition-delete-failure-original", visualAssetId: "asset-transition-delete-failure", version: 1, variant: "ORIGINAL", r2Key: "visuals/asset-transition-delete-failure/original.jpg" });
    fixture.insertAssetVersion({ id: "asset-transition-delete-failure-capsule", visualAssetId: "asset-transition-delete-failure", version: 1, variant: "CAPSULE", r2Key: "visuals/asset-transition-delete-failure/capsule.webp" });
    fixture.insertAnalysis({
      id: "analysis-transition-delete-failure-user",
      visualAssetId: "asset-transition-delete-failure",
      visualVersionId: "asset-transition-delete-failure-capsule",
      analysisType: "USER_VERIFIED",
      payload: validVisualAnalysisPayload("transition-delete-failure-user"),
      reviewStatus: "ACCEPTED",
      createdAt: "2026-08-25T07:21:00.000Z",
    });
    fixture.failNextR2Delete();

    const { default: visualAssets } = await import("../../../worker/src/routes/visualAssets");
    const response = await visualAssets.request("/asset-transition-delete-failure/storage-transition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "CAPSULE", confirmation: "DELETE_ORIGINAL" }),
    }, fixture.env);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "visual_storage_delete_failed" });
    expect(fixture.assetRow("asset-transition-delete-failure")).toMatchObject({
      storage_state: "ARCHIVAL",
      pending_storage_state: "CAPSULE",
    });
    expect(fixture.assetVersionRow("asset-transition-delete-failure-original")?.deleted_at).toBeNull();
    expect(fixture.operationRowsFor("asset-transition-delete-failure")).toEqual([
      expect.objectContaining({
        operation_kind: "DELETE_ORIGINAL",
        status: "FAILED",
        error: expect.stringContaining("uncertain"),
      }),
    ]);
  });
});

describe("scheduled visual cleanup isolation", () => {
  it("runs cleanup in isolation so cron success paths still complete when cleanup throws", async () => {
    const runScheduledCron = vi.fn().mockResolvedValue({ status: "PARTIAL" });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.doMock("../../../worker/src/operations/scheduled", () => ({ runScheduledCron }));

    const worker = await import("../../../worker/src/index");
    const env = { DB: {} as D1Database } as Env;

    await worker.default.scheduled({ cron: "0 1 * * *" } as ScheduledEvent, env);
    await worker.default.scheduled({ cron: "0 9 * * 1" } as ScheduledEvent, env);

    expect(runScheduledCron).toHaveBeenNthCalledWith(1, env, "0 1 * * *");
    expect(runScheduledCron).toHaveBeenNthCalledWith(2, env, "0 9 * * 1");
    expect(infoLog).toHaveBeenCalledTimes(2);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("uses a dedicated hourly cleanup schedule without running research cron handlers", async () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "../worker/wrangler.jsonc"), "utf8")) as {
      triggers?: { crons?: string[] };
    };
    expect(config.triggers?.crons).toContain("0 * * * *");

    const runScheduledCron = vi.fn().mockResolvedValue({ status: "SUCCEEDED" });

    vi.doMock("../../../worker/src/operations/scheduled", () => ({ runScheduledCron }));

    const worker = await import("../../../worker/src/index");
    await worker.default.scheduled({ cron: "0 * * * *" } as ScheduledEvent, { DB: {} as D1Database } as Env);

    expect(runScheduledCron).toHaveBeenCalledTimes(1);
    expect(runScheduledCron).toHaveBeenCalledWith(expect.anything(), "0 * * * *");
  });
});

function verifyVisualExtractionMigration(): {
  foreignKeyCheck: string;
  invalidRunStatusError: string;
  invalidUnitStatusError: string;
  duplicateActiveRunError: string;
  recreatedRunCount: number;
  expiredTempIndexSql: string;
  duplicateCandidateError: string;
  recreatedCandidateCount: number;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-0018-"));
  const dbPath = join(tempDir, "migration.sqlite");
  const seedPath = join(tempDir, "seed.sql");
  const migrationPath = join(process.cwd(), "../worker/migrations/0018_visual_extraction_and_review.sql");
  const migrationSql = readFileSync(migrationPath, "utf8");

  try {
    writeFileSync(
      seedPath,
      [
        "PRAGMA foreign_keys=OFF;",
        "CREATE TABLE sources (id TEXT PRIMARY KEY);",
        "CREATE TABLE source_versions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id));",
        "CREATE TABLE visual_assets (id TEXT PRIMARY KEY, parent_source_id TEXT REFERENCES sources(id), parent_version_id TEXT REFERENCES source_versions(id), origin_kind TEXT NOT NULL, source_url TEXT, page_number INTEGER, figure_label TEXT, bbox_json TEXT, caption TEXT, nearby_text TEXT, asset_role TEXT NOT NULL DEFAULT 'PERSONAL_WORK', visual_kind TEXT NOT NULL DEFAULT 'OTHER', selection_status TEXT NOT NULL DEFAULT 'SELECTED', selection_reason TEXT, rights_status TEXT NOT NULL DEFAULT 'PERSONAL', is_personal_work INTEGER NOT NULL DEFAULT 1, assignment_status TEXT NOT NULL DEFAULT 'UNASSIGNED', storage_state TEXT NOT NULL DEFAULT 'ARCHIVAL', pending_storage_state TEXT, processing_status TEXT NOT NULL DEFAULT 'UPLOADED', last_error TEXT, content_hash TEXT, perceptual_hash TEXT, perceptual_hash_method TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);",
        "CREATE TABLE visual_asset_versions (id TEXT PRIMARY KEY, visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id), version INTEGER NOT NULL, variant TEXT NOT NULL, r2_key TEXT, mime_type TEXT NOT NULL, width INTEGER, height INTEGER, byte_size INTEGER NOT NULL, content_hash TEXT NOT NULL, transform_profile_json TEXT, parent_asset_version_id TEXT REFERENCES visual_asset_versions(id), created_at TEXT NOT NULL, deleted_at TEXT);",
        "CREATE TABLE visual_analyses (id TEXT PRIMARY KEY, visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id), visual_version_id TEXT NOT NULL REFERENCES visual_asset_versions(id), analysis_type TEXT NOT NULL, provenance_class TEXT NOT NULL, payload_json TEXT NOT NULL, model_id TEXT, prompt_version TEXT, cost_usd REAL NOT NULL DEFAULT 0, confidence REAL, review_status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL, reviewed_at TEXT);",
        "INSERT INTO sources VALUES ('source-1');",
        "INSERT INTO source_versions VALUES ('version-1', 'source-1');",
        "PRAGMA foreign_keys=ON;",
        migrationSql,
      ].join("\n"),
      "utf8",
    );

    execFileSync("sqlite3", [dbPath], {
      cwd: tempDir,
      input: readFileSync(seedPath, "utf8"),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });

    const invalidRunStatusError = runSqlExpectError(
      tempDir,
      dbPath,
      "INSERT INTO visual_extraction_runs (id, parent_source_id, parent_version_id, origin_kind, status, total_units, uploaded_units, processed_units, selected_count, review_count, filtered_count, unavailable_count, created_at, updated_at) VALUES ('run-invalid', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'WAITING', 0, 0, 0, 0, 0, 0, 0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');",
    );
    const invalidUnitStatusError = runSqlExpectError(
      tempDir,
      dbPath,
      [
        "INSERT INTO visual_extraction_runs (id, parent_source_id, parent_version_id, origin_kind, status, total_units, uploaded_units, processed_units, selected_count, review_count, filtered_count, unavailable_count, created_at, updated_at) VALUES ('run-status', 'source-1', 'version-1', 'WEB_EMBED', 'QUEUED', 0, 0, 0, 0, 0, 0, 0, '2026-08-25T00:00:30.000Z', '2026-08-25T00:00:30.000Z');",
        "INSERT INTO visual_extraction_units (id, run_id, unit_number, candidate_key, status, created_at) VALUES ('unit-invalid', 'run-status', 1, 'candidate-invalid', 'PENDING', '2026-08-25T00:00:30.000Z');",
      ].join("\n"),
    );

    const duplicateActiveRunError = runSqlExpectError(
      tempDir,
      dbPath,
      [
        "INSERT INTO visual_extraction_runs (id, parent_source_id, parent_version_id, origin_kind, status, total_units, uploaded_units, processed_units, selected_count, review_count, filtered_count, unavailable_count, created_at, updated_at) VALUES ('run-1', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'QUEUED', 0, 0, 0, 0, 0, 0, 0, '2026-08-25T00:00:00.000Z', '2026-08-25T00:00:00.000Z');",
        "INSERT INTO visual_extraction_runs (id, parent_source_id, parent_version_id, origin_kind, status, total_units, uploaded_units, processed_units, selected_count, review_count, filtered_count, unavailable_count, created_at, updated_at) VALUES ('run-2', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'RUNNING', 0, 0, 0, 0, 0, 0, 0, '2026-08-25T00:01:00.000Z', '2026-08-25T00:01:00.000Z');",
      ].join("\n"),
    );

    execFileSync("sqlite3", [dbPath], {
      cwd: tempDir,
      input: [
        "UPDATE visual_extraction_runs SET status = 'SUCCEEDED', finished_at = '2026-08-25T00:02:00.000Z' WHERE id = 'run-1';",
        "INSERT INTO visual_extraction_runs (id, parent_source_id, parent_version_id, origin_kind, status, total_units, uploaded_units, processed_units, selected_count, review_count, filtered_count, unavailable_count, created_at, updated_at) VALUES ('run-3', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'QUEUED', 0, 0, 0, 0, 0, 0, 0, '2026-08-25T00:03:00.000Z', '2026-08-25T00:03:00.000Z');",
        "INSERT INTO visual_extraction_units (id, run_id, unit_number, candidate_key, status, temp_r2_key, created_at) VALUES ('unit-expired', 'run-3', 1, 'page-1', 'UPLOADED', 'tmp/expired.webp', '2026-08-25T00:03:00.000Z');",
        "INSERT INTO visual_extraction_units (id, run_id, unit_number, candidate_key, status, temp_r2_key, created_at, processed_at) VALUES ('unit-fresh', 'run-3', 2, 'page-2', 'SUCCEEDED', 'tmp/fresh.webp', '2026-08-25T00:04:00.000Z', '2026-08-25T00:05:00.000Z');",
        "INSERT INTO visual_assets (id, parent_source_id, parent_version_id, origin_kind, candidate_key, created_at, updated_at) VALUES ('asset-1', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'page-1', '2026-08-25T00:06:00.000Z', '2026-08-25T00:06:00.000Z');",
      ].join("\n"),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });

    const duplicateCandidateError = runSqlExpectError(
      tempDir,
      dbPath,
      "INSERT INTO visual_assets (id, parent_source_id, parent_version_id, origin_kind, candidate_key, created_at, updated_at) VALUES ('asset-2', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'page-1', '2026-08-25T00:07:00.000Z', '2026-08-25T00:07:00.000Z');",
    );

    execFileSync("sqlite3", [dbPath], {
      cwd: tempDir,
      input: [
        "UPDATE visual_assets SET deleted_at = '2026-08-25T00:08:00.000Z' WHERE id = 'asset-1';",
        "INSERT INTO visual_assets (id, parent_source_id, parent_version_id, origin_kind, candidate_key, created_at, updated_at) VALUES ('asset-3', 'source-1', 'version-1', 'PDF_PAGE_CROP', 'page-1', '2026-08-25T00:09:00.000Z', '2026-08-25T00:09:00.000Z');",
      ].join("\n"),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });

    const foreignKeyCheck = runSqlQuery(tempDir, dbPath, "PRAGMA foreign_key_check;");
    const expiredTempIndexSql = runSqlQuery(
      tempDir,
      dbPath,
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_visual_extraction_units_expired_temp';",
    );
    const recreatedRunCount = Number(runSqlQuery(tempDir, dbPath, "SELECT COUNT(*) FROM visual_extraction_runs WHERE parent_version_id = 'version-1' AND origin_kind = 'PDF_PAGE_CROP';"));
    const recreatedCandidateCount = Number(runSqlQuery(tempDir, dbPath, "SELECT COUNT(*) FROM visual_assets WHERE parent_version_id = 'version-1' AND origin_kind = 'PDF_PAGE_CROP' AND candidate_key = 'page-1';"));

    return {
      foreignKeyCheck,
      invalidRunStatusError,
      invalidUnitStatusError,
      duplicateActiveRunError,
      recreatedRunCount,
      expiredTempIndexSql,
      duplicateCandidateError,
      recreatedCandidateCount,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runSqlQuery(tempDir: string, dbPath: string, sql: string): string {
  return execFileSync("sqlite3", [dbPath, sql], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function runSqlExpectError(tempDir: string, dbPath: string, sql: string): string {
  try {
    execFileSync("sqlite3", [dbPath], {
      cwd: tempDir,
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type RunState = {
  id: string;
  parentSourceId: string;
  parentVersionId: string;
  originKind: string;
  status: string;
  totalUnits: number;
  uploadedUnits: number;
  processedUnits: number;
  selectedCount: number;
  reviewCount: number;
  filteredCount: number;
  unavailableCount: number;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  visionCallLimit?: number;
  visionReservationUsd?: number;
  visionBudgetReserved?: number;
  visionReservationId?: string | null;
  visionReservationJobId?: string | null;
  visionBudgetBlocked?: number;
  visionSlotsUsed?: number;
  visionAttempted?: number;
  visionCompleted?: number;
  visionFailed?: number;
  visionBlocked?: number;
  visionCapBlocked?: number;
};

function normalizeVisionRunState(run: RunState): RunState {
  run.visionCallLimit ??= 80;
  run.visionReservationUsd ??= 0;
  run.visionBudgetReserved ??= 0;
  run.visionReservationId ??= null;
  run.visionReservationJobId ??= null;
  run.visionBudgetBlocked ??= 0;
  run.visionSlotsUsed ??= 0;
  run.visionAttempted ??= 0;
  run.visionCompleted ??= 0;
  run.visionFailed ??= 0;
  run.visionBlocked ??= 0;
  run.visionCapBlocked ??= 0;
  return run;
}

type UnitState = {
  id: string;
  runId: string;
  unitNumber: number;
  candidateKey: string;
  status: string;
  tempR2Key: string | null;
  width: number | null;
  height: number | null;
  contentHash: string | null;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
  deletedAt: string | null;
};

function validVisualAnalysisPayload(label: string) {
  return {
    observation: {
      subject: [`subject ${label}`],
      composition: [`composition ${label}`],
      color: [`color ${label}`],
      texture: [],
      spatialRelation: [],
      material: [],
      lighting: [],
      visibleText: [],
    },
    formal: {
      shapes: [],
      lines: [],
      planes: [],
      rhythm: [],
      scale: [],
      density: [],
      edges: [],
      contrast: [],
      perspective: [],
    },
    context: {
      medium: [`medium ${label}`],
      process: [],
      relationToPhotography: [],
      culturalReferences: [],
    },
    propositions: [`proposition ${label}`],
    uncertainty: [],
    visualKind: "DIAGRAM",
    confidence: 0.8,
  };
}

function createVisualAssetRouteFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "radar-visual-route-"));
  const dbPath = join(tempDir, "visual-route.sqlite");
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE threads (id TEXT PRIMARY KEY);
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      active_version_id TEXT,
      title TEXT,
      origin TEXT,
      input_format TEXT
    );
    CREATE TABLE source_deletion_claims (
      source_id TEXT PRIMARY KEY
    );
    CREATE TABLE source_versions (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id),
      version INTEGER NOT NULL,
      r2_key TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-08-25T00:00:00.000Z'
    );
    CREATE TABLE visual_assets (
      id TEXT PRIMARY KEY,
      parent_source_id TEXT REFERENCES sources(id),
      parent_version_id TEXT REFERENCES source_versions(id),
      origin_kind TEXT NOT NULL,
      source_url TEXT,
      page_number INTEGER,
      figure_label TEXT,
      bbox_json TEXT,
      candidate_key TEXT,
      caption TEXT,
      nearby_text TEXT,
      asset_role TEXT NOT NULL DEFAULT 'PERSONAL_WORK',
      visual_kind TEXT NOT NULL DEFAULT 'OTHER',
      selection_status TEXT NOT NULL DEFAULT 'SELECTED',
      selection_reason TEXT,
      rights_status TEXT NOT NULL DEFAULT 'PERSONAL',
      rights_basis TEXT,
      rights_reviewed_at TEXT,
      is_personal_work INTEGER NOT NULL DEFAULT 1,
      assignment_status TEXT NOT NULL DEFAULT 'UNASSIGNED',
      storage_state TEXT NOT NULL DEFAULT 'ARCHIVAL',
      pending_storage_state TEXT,
      processing_status TEXT NOT NULL DEFAULT 'UPLOADED',
      last_error TEXT,
      content_hash TEXT,
      perceptual_hash TEXT,
      perceptual_hash_method TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE visual_asset_versions (
      id TEXT PRIMARY KEY,
      visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
      version INTEGER NOT NULL,
      variant TEXT NOT NULL,
      r2_key TEXT,
      mime_type TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      byte_size INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      parent_asset_version_id TEXT REFERENCES visual_asset_versions(id),
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE visual_analyses (
      id TEXT PRIMARY KEY,
      visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
      visual_version_id TEXT NOT NULL REFERENCES visual_asset_versions(id),
      analysis_type TEXT NOT NULL,
      provenance_class TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      model_id TEXT,
      prompt_version TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      confidence REAL,
      review_status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      parent_analysis_id TEXT REFERENCES visual_analyses(id)
    );
    CREATE TABLE visual_relations (
      id TEXT PRIMARY KEY,
      from_visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
      to_visual_asset_id TEXT REFERENCES visual_assets(id),
      related_source_id TEXT REFERENCES sources(id),
      related_thread_id TEXT REFERENCES threads(id),
      relation_kind TEXT NOT NULL,
      created_by TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE visual_extraction_runs (
      id TEXT PRIMARY KEY,
      parent_source_id TEXT NOT NULL REFERENCES sources(id),
      parent_version_id TEXT NOT NULL REFERENCES source_versions(id),
      origin_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      total_units INTEGER NOT NULL DEFAULT 0,
      uploaded_units INTEGER NOT NULL DEFAULT 0,
      processed_units INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      review_count INTEGER NOT NULL DEFAULT 0,
      filtered_count INTEGER NOT NULL DEFAULT 0,
      unavailable_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE visual_extraction_units (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES visual_extraction_runs(id),
      unit_number INTEGER NOT NULL,
      candidate_key TEXT NOT NULL,
      status TEXT NOT NULL,
      temp_r2_key TEXT,
      width INTEGER,
      height INTEGER,
      content_hash TEXT,
      error_code TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE visual_asset_operations (
      id TEXT PRIMARY KEY,
      visual_asset_id TEXT NOT NULL REFERENCES visual_assets(id),
      operation_kind TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE research_jobs (
      id TEXT PRIMARY KEY,
      workflow_instance_id TEXT UNIQUE,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      input_json TEXT NOT NULL,
      result_json TEXT,
      result_ref_json TEXT,
      error_code TEXT,
      error TEXT,
      retry_of TEXT REFERENCES research_jobs(id),
      requested_by TEXT,
      dedupe_key TEXT NOT NULL,
      dismissed_at TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_research_jobs_active_dedupe
      ON research_jobs(dedupe_key)
      WHERE status IN ('QUEUED', 'RUNNING');
  `);

  let failAfterR2Delete = false;
  let failNextBatch = false;
  let failNextDelete = false;
  const d1 = sqliteToD1(sqlite, () => {
    if (!failNextBatch) return false;
    failNextBatch = false;
    return true;
  });
  const deleteCalls: string[] = [];
  const workflowCreate = vi.fn(async ({ id }: { id: string }) => ({ id: `workflow:${id}` }));
  const env = {
    DB: d1,
    ORIGINALS: {
      get: vi.fn(),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async (key: string) => {
        deleteCalls.push(key);
        if (failNextDelete) {
          failNextDelete = false;
          throw new Error("simulated_r2_delete_failure");
        }
        if (failAfterR2Delete) {
          failAfterR2Delete = false;
          failNextBatch = true;
        }
      }),
    },
    IMAGES: {
      info: vi.fn(async () => ({ format: "image/jpeg", width: 1, height: 1 })),
    },
    RESEARCH_JOBS_WORKFLOW: { create: workflowCreate },
  } as unknown as Env;

  return {
    env,
    sqlite,
    workflowCreate,
    deleteCalls,
    failNextBatchAfterR2Delete() {
      failAfterR2Delete = true;
    },
    failNextR2Delete() {
      failNextDelete = true;
    },
    insertSource(input: {
      id: string;
      activeVersionId: string | null;
      title?: string | null;
      origin?: string | null;
      inputFormat?: string | null;
    }) {
      sqlite.prepare(
        `INSERT INTO sources (id, active_version_id, title, origin, input_format)
         VALUES (?, ?, ?, ?, ?)`
      ).run(input.id, input.activeVersionId, input.title ?? null, input.origin ?? null, input.inputFormat ?? null);
    },
    insertSourceVersion(input: {
      id: string;
      sourceId: string;
      version: number;
      r2Key?: string | null;
      createdAt?: string;
    }) {
      sqlite.prepare(
        `INSERT INTO source_versions (id, source_id, version, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(input.id, input.sourceId, input.version, input.r2Key ?? null, input.createdAt ?? "2026-08-25T00:00:00.000Z");
    },
    insertAsset(input: {
      id: string;
      parentSourceId?: string | null;
      parentVersionId?: string | null;
      originKind?: string;
      sourceUrl?: string | null;
      pageNumber?: number | null;
      figureLabel?: string | null;
      bboxJson?: string | null;
      candidateKey?: string | null;
      caption?: string | null;
      nearbyText?: string | null;
      visualKind?: string;
      selectionStatus?: string;
      selectionReason?: string | null;
      rightsStatus?: string;
      rightsBasis?: string | null;
      rightsReviewedAt?: string | null;
      isPersonalWork?: number;
      assignmentStatus?: string;
      storageState?: string;
      pendingStorageState?: string | null;
      processingStatus?: string;
      createdAt?: string;
      updatedAt?: string;
    }) {
      const createdAt = input.createdAt ?? "2026-08-25T00:00:00.000Z";
      const updatedAt = input.updatedAt ?? createdAt;
      sqlite.prepare(
        `INSERT INTO visual_assets
         (id, parent_source_id, parent_version_id, origin_kind, source_url, page_number, figure_label,
          bbox_json, candidate_key, caption, nearby_text, asset_role, visual_kind, selection_status,
          selection_reason, rights_status, rights_basis, rights_reviewed_at, is_personal_work,
          assignment_status, storage_state, pending_storage_state, processing_status, last_error,
          content_hash, perceptual_hash, perceptual_hash_method, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REFERENCE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'hash', NULL, NULL, ?, ?, NULL)`
      ).run(
        input.id,
        input.parentSourceId ?? null,
        input.parentVersionId ?? null,
        input.originKind ?? "WEB_EMBED",
        input.sourceUrl ?? null,
        input.pageNumber ?? null,
        input.figureLabel ?? null,
        input.bboxJson ?? null,
        input.candidateKey ?? null,
        input.caption ?? null,
        input.nearbyText ?? null,
        input.visualKind ?? "OTHER",
        input.selectionStatus ?? "SELECTED",
        input.selectionReason ?? null,
        input.rightsStatus ?? "PERSONAL",
        input.rightsBasis ?? null,
        input.rightsReviewedAt ?? null,
        input.isPersonalWork ?? 1,
        input.assignmentStatus ?? (input.parentSourceId ? "ASSIGNED" : "UNASSIGNED"),
        input.storageState ?? "ARCHIVAL",
        input.pendingStorageState ?? null,
        input.processingStatus ?? "READY",
        createdAt,
        updatedAt,
      );
    },
    insertAssetVersion(input: {
      id: string;
      visualAssetId: string;
      version: number;
      variant: string;
      r2Key?: string | null;
      mimeType?: string;
      byteSize?: number;
      contentHash?: string;
      createdAt?: string;
      deletedAt?: string | null;
    }) {
      sqlite.prepare(
        `INSERT INTO visual_asset_versions
         (id, visual_asset_id, version, variant, r2_key, mime_type, width, height, byte_size, content_hash, parent_asset_version_id, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`
      ).run(
        input.id,
        input.visualAssetId,
        input.version,
        input.variant,
        input.r2Key ?? null,
        input.mimeType ?? (input.variant === "CAPSULE" ? "image/webp" : "image/jpeg"),
        input.byteSize ?? 1024,
        input.contentHash ?? `${input.id}-hash`,
        input.createdAt ?? "2026-08-25T00:00:00.000Z",
        input.deletedAt ?? null,
      );
    },
    insertAnalysis(input: {
      id: string;
      visualAssetId: string;
      visualVersionId: string;
      analysisType: string;
      payload: Record<string, unknown>;
      reviewStatus?: string;
      parentAnalysisId?: string | null;
      createdAt?: string;
      reviewedAt?: string | null;
    }) {
      sqlite.prepare(
        `INSERT INTO visual_analyses
         (id, visual_asset_id, visual_version_id, analysis_type, provenance_class, payload_json, model_id, prompt_version, cost_usd, confidence, review_status, created_at, reviewed_at, parent_analysis_id)
         VALUES (?, ?, ?, ?, 'INTERPRETATION', ?, 'vision-low', 'visual-v1', 0, 0.8, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.visualAssetId,
        input.visualVersionId,
        input.analysisType,
        JSON.stringify(input.payload),
        input.reviewStatus ?? "PENDING",
        input.createdAt ?? "2026-08-25T00:00:00.000Z",
        input.reviewedAt ?? null,
        input.parentAnalysisId ?? null,
      );
    },
    insertRelation(input: {
      id: string;
      fromVisualAssetId: string;
      toVisualAssetId?: string | null;
      relatedSourceId?: string | null;
      relatedThreadId?: string | null;
      relationKind: string;
      createdBy: string;
      description?: string | null;
      createdAt?: string;
    }) {
      sqlite.prepare(
        `INSERT INTO visual_relations
         (id, from_visual_asset_id, to_visual_asset_id, related_source_id, related_thread_id, relation_kind, created_by, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.id,
        input.fromVisualAssetId,
        input.toVisualAssetId ?? null,
        input.relatedSourceId ?? null,
        input.relatedThreadId ?? null,
        input.relationKind,
        input.createdBy,
        input.description ?? null,
        input.createdAt ?? "2026-08-25T00:00:00.000Z",
      );
    },
    insertExtractionRun(input: {
      id: string;
      parentSourceId: string;
      parentVersionId: string;
      originKind: string;
      status: string;
      totalUnits: number;
      uploadedUnits: number;
      processedUnits: number;
      selectedCount: number;
      reviewCount: number;
      filteredCount: number;
      unavailableCount: number;
      createdAt?: string;
      updatedAt?: string;
      finishedAt?: string | null;
    }) {
      sqlite.prepare(
        `INSERT INTO visual_extraction_runs
         (id, parent_source_id, parent_version_id, origin_kind, status, total_units, uploaded_units, processed_units, selected_count, review_count, filtered_count, unavailable_count, error_code, error, created_at, updated_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
      ).run(
        input.id,
        input.parentSourceId,
        input.parentVersionId,
        input.originKind,
        input.status,
        input.totalUnits,
        input.uploadedUnits,
        input.processedUnits,
        input.selectedCount,
        input.reviewCount,
        input.filteredCount,
        input.unavailableCount,
        input.createdAt ?? "2026-08-25T00:00:00.000Z",
        input.updatedAt ?? input.createdAt ?? "2026-08-25T00:00:00.000Z",
        input.finishedAt ?? null,
      );
    },
    insertExtractionUnit(input: {
      id: string;
      runId: string;
      unitNumber: number;
      candidateKey: string;
      status: string;
      createdAt?: string;
      processedAt?: string | null;
      tempR2Key?: string | null;
    }) {
      sqlite.prepare(
        `INSERT INTO visual_extraction_units
         (id, run_id, unit_number, candidate_key, status, temp_r2_key, width, height, content_hash, error_code, error, created_at, processed_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`
      ).run(
        input.id,
        input.runId,
        input.unitNumber,
        input.candidateKey,
        input.status,
        input.tempR2Key ?? null,
        input.createdAt ?? "2026-08-25T00:00:00.000Z",
        input.processedAt ?? null,
      );
    },
    assetRow(id: string) {
      return sqlite.prepare("SELECT * FROM visual_assets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    },
    assetVersionRow(id: string) {
      return sqlite.prepare("SELECT * FROM visual_asset_versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    },
    extractionUnitRow(id: string) {
      return sqlite.prepare("SELECT * FROM visual_extraction_units WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    },
    analysisRowsFor(visualAssetId: string) {
      return sqlite.prepare("SELECT * FROM visual_analyses WHERE visual_asset_id = ? ORDER BY created_at ASC, id ASC").all(visualAssetId) as Record<string, unknown>[];
    },
    operationRowsFor(visualAssetId: string) {
      return sqlite.prepare("SELECT * FROM visual_asset_operations WHERE visual_asset_id = ? ORDER BY created_at ASC").all(visualAssetId) as Record<string, unknown>[];
    },
    relationRowsFor(visualAssetId: string) {
      return sqlite.prepare("SELECT * FROM visual_relations WHERE from_visual_asset_id = ? ORDER BY created_at ASC, id ASC").all(visualAssetId) as Record<string, unknown>[];
    },
    jobRows() {
      return sqlite.prepare("SELECT * FROM research_jobs ORDER BY created_at ASC, id ASC").all() as Record<string, unknown>[];
    },
  };
}

function sqliteToD1(sqlite: DatabaseSync, shouldFailBatch: () => boolean = () => false): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      const statement = sqlite.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          params = values;
          return this;
        },
        async first<T = Record<string, unknown>>() {
          return (statement.get(...params) as T | undefined) ?? null;
        },
        async all<T = Record<string, unknown>>() {
          return { results: statement.all(...params) as T[] };
        },
        async run() {
          const result = statement.run(...params) as { changes?: number | bigint };
          return { success: true, meta: { changes: Number(result.changes ?? 0) } };
        },
      } as D1PreparedStatement;
    },
    async batch(statements: D1PreparedStatement[]) {
      if (shouldFailBatch()) throw new Error("simulated_db_finalize_failure");
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}

function createExtractionDb(seed: {
  runs?: RunState[];
  units?: UnitState[];
  reservations?: Array<{ id: string; researchJobId: string; status: "RESERVED" | "RELEASED" }>;
  simulateRunInsertRace?: {
    parentSourceId: string;
    parentVersionId: string;
    originKind: string;
    canonicalId: string;
    createdAt: string;
  };
  simulateUnitInsertRace?: {
    runId: string;
    unitNumber: number;
    candidateKey: string;
    canonicalId: string;
    createdAt: string;
  };
} = {}): D1Database & { state: { runs: RunState[]; units: UnitState[] } } {
  const state = {
    runs: [...(seed.runs ?? [])].map(normalizeVisionRunState),
    units: [...(seed.units ?? [])],
    reservations: [...(seed.reservations ?? [])],
  };

  const db = {
    prepare(query: string): D1PreparedStatement {
      let params: unknown[] = [];

      return {
        bind(...values: unknown[]): D1PreparedStatement {
          params = values;
          return this;
        },
        async first<T = unknown>() {
          if (query.includes("SELECT CASE WHEN vision_budget_reserved")) {
            const [runId] = params as [string];
            const run = state.runs.find((entry) => entry.id === runId);
            const authorized = run && run.visionBudgetReserved === 1 && state.reservations.some((reservation) =>
              reservation.id === run.visionReservationId
              && reservation.researchJobId === run.visionReservationJobId
              && reservation.status === "RESERVED"
            ) ? 1 : 0;
            return { authorized } as T;
          }
          if (query.includes("FROM visual_extraction_runs") && query.includes("status IN ('UPLOADING', 'QUEUED', 'RUNNING')")) {
            const [parentSourceId, parentVersionId, originKind] = params as [string, string, string];
            return state.runs.find((run) => run.parentSourceId === parentSourceId && run.parentVersionId === parentVersionId && run.originKind === originKind && ["UPLOADING", "QUEUED", "RUNNING"].includes(run.status)) as T | null;
          }
          if (query.includes("FROM visual_extraction_runs WHERE id = ?")) {
            const [runId] = params as [string];
            return state.runs.find((run) => run.id === runId) as T | null;
          }
          if (query.includes("FROM visual_extraction_units") && query.includes("run_id = ?") && query.includes("unit_number = ?") && query.includes("candidate_key = ?")) {
            const [runId, unitNumber, candidateKey] = params as [string, number, string];
            return state.units.find((unit) => unit.runId === runId && unit.unitNumber === unitNumber && unit.candidateKey === candidateKey && unit.deletedAt == null) as T | null;
          }
          return null;
        },
        async run() {
          if (query.includes("visual_extraction_runs") && query.includes("INSERT")) {
            const [id, parentSourceId, parentVersionId, originKind, status, totalUnits, uploadedUnits, processedUnits, selectedCount, reviewCount, filteredCount, unavailableCount, errorCode, error, createdAt, updatedAt, finishedAt, visionCallLimit, visionReservationUsd, visionBudgetReserved, visionBudgetBlocked, visionReservationId, visionReservationJobId, visionSlotsUsed, visionAttempted, visionCompleted, visionFailed, visionBlocked, visionCapBlocked] = params as [
              string,
              string,
              string,
              string,
              string,
              number,
              number,
              number,
              number,
              number,
              number,
              number,
              string | null,
              string | null,
              string,
              string,
              string | null,
              number,
              number,
              number,
              number,
              string | null,
              string | null,
              number,
              number,
              number,
              number,
              number,
              number,
            ];

            if (
              seed.simulateRunInsertRace &&
              !query.includes("INSERT OR IGNORE") &&
              seed.simulateRunInsertRace.parentSourceId === parentSourceId &&
              seed.simulateRunInsertRace.parentVersionId === parentVersionId &&
              seed.simulateRunInsertRace.originKind === originKind
            ) {
              state.runs.push(normalizeVisionRunState({
                id: seed.simulateRunInsertRace.canonicalId,
                parentSourceId,
                parentVersionId,
                originKind,
                status,
                totalUnits,
                uploadedUnits,
                processedUnits,
                selectedCount,
                reviewCount,
                filteredCount,
                unavailableCount,
                errorCode,
                error,
                createdAt: seed.simulateRunInsertRace.createdAt,
                updatedAt,
                finishedAt,
                visionCallLimit,
                visionReservationUsd,
                visionBudgetReserved,
                visionBudgetBlocked,
                visionReservationId,
                visionReservationJobId,
                visionSlotsUsed,
                visionAttempted,
                visionCompleted,
                visionFailed,
                visionBlocked,
                visionCapBlocked,
              }));
              throw new Error("UNIQUE constraint failed: visual_extraction_runs.parent_version_id, visual_extraction_runs.origin_kind");
            }
            if (
              seed.simulateRunInsertRace &&
              query.includes("INSERT OR IGNORE") &&
              seed.simulateRunInsertRace.parentSourceId === parentSourceId &&
              seed.simulateRunInsertRace.parentVersionId === parentVersionId &&
              seed.simulateRunInsertRace.originKind === originKind
            ) {
              state.runs.push(normalizeVisionRunState({
                id: seed.simulateRunInsertRace.canonicalId,
                parentSourceId,
                parentVersionId,
                originKind,
                status,
                totalUnits,
                uploadedUnits,
                processedUnits,
                selectedCount,
                reviewCount,
                filteredCount,
                unavailableCount,
                errorCode,
                error,
                createdAt: seed.simulateRunInsertRace.createdAt,
                updatedAt,
                finishedAt,
                visionCallLimit,
                visionReservationUsd,
                visionBudgetReserved,
                visionBudgetBlocked,
                visionReservationId,
                visionReservationJobId,
                visionSlotsUsed,
                visionAttempted,
                visionCompleted,
                visionFailed,
                visionBlocked,
                visionCapBlocked,
              }));
              delete seed.simulateRunInsertRace;
              return { success: true, meta: { changes: 0 } };
            }
            if (
              query.includes("INSERT OR IGNORE") &&
              state.runs.some((entry) => entry.parentVersionId === parentVersionId && entry.originKind === originKind && ["UPLOADING", "QUEUED", "RUNNING"].includes(entry.status))
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            state.runs.push(normalizeVisionRunState({
              id,
              parentSourceId,
              parentVersionId,
              originKind,
              status,
              totalUnits,
              uploadedUnits,
              processedUnits,
              selectedCount,
              reviewCount,
              filteredCount,
              unavailableCount,
              errorCode,
              error,
              createdAt,
              updatedAt,
              finishedAt,
              visionCallLimit,
              visionReservationUsd,
              visionBudgetReserved,
              visionBudgetBlocked,
              visionReservationId,
              visionReservationJobId,
              visionSlotsUsed,
              visionAttempted,
              visionCompleted,
              visionFailed,
              visionBlocked,
              visionCapBlocked,
            }));
          }

          if (query.includes("visual_extraction_units") && query.includes("INSERT")) {
            const [id, runId, unitNumber, candidateKey, status, tempR2Key, width, height, contentHash, errorCode, error, createdAt, processedAt, deletedAt] = params as [
              string,
              string,
              number,
              string,
              string,
              string | null,
              number | null,
              number | null,
              string | null,
              string | null,
              string | null,
              string,
              string | null,
              string | null,
            ];

            if (
              seed.simulateUnitInsertRace &&
              !query.includes("INSERT OR IGNORE") &&
              seed.simulateUnitInsertRace.runId === runId &&
              seed.simulateUnitInsertRace.unitNumber === unitNumber &&
              seed.simulateUnitInsertRace.candidateKey === candidateKey
            ) {
              state.units.push({
                id: seed.simulateUnitInsertRace.canonicalId,
                runId,
                unitNumber,
                candidateKey,
                status,
                tempR2Key,
                width,
                height,
                contentHash,
                errorCode,
                error,
                createdAt: seed.simulateUnitInsertRace.createdAt,
                processedAt,
                deletedAt,
              });
              throw new Error("UNIQUE constraint failed: visual_extraction_units.run_id, visual_extraction_units.unit_number, visual_extraction_units.candidate_key");
            }
            if (
              seed.simulateUnitInsertRace &&
              query.includes("INSERT OR IGNORE") &&
              seed.simulateUnitInsertRace.runId === runId &&
              seed.simulateUnitInsertRace.unitNumber === unitNumber &&
              seed.simulateUnitInsertRace.candidateKey === candidateKey
            ) {
              state.units.push({
                id: seed.simulateUnitInsertRace.canonicalId,
                runId,
                unitNumber,
                candidateKey,
                status,
                tempR2Key,
                width,
                height,
                contentHash,
                errorCode,
                error,
                createdAt: seed.simulateUnitInsertRace.createdAt,
                processedAt,
                deletedAt,
              });
              delete seed.simulateUnitInsertRace;
              return { success: true, meta: { changes: 0 } };
            }
            if (
              query.includes("INSERT OR IGNORE") &&
              state.units.some((entry) => entry.runId === runId && entry.unitNumber === unitNumber && entry.candidateKey === candidateKey)
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            state.units.push({
              id,
              runId,
              unitNumber,
              candidateKey,
              status,
              tempR2Key,
              width,
              height,
              contentHash,
              errorCode,
              error,
              createdAt,
              processedAt,
              deletedAt,
            });
          }

          if (query.includes("UPDATE visual_extraction_units") && query.includes("WHERE id = ?")) {
            const [deletedAt, unitId] = params as [string, string];
            const unit = state.units.find((entry) => entry.id === unitId && entry.deletedAt == null);
            if (unit) unit.deletedAt = deletedAt;
            return { success: true, meta: { changes: unit ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_units")) {
            const [status, width, height, contentHash, errorCode, error, processedAt, deletedAt, runId, unitNumber, candidateKey] = params as [
              string,
              number | null,
              number | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string,
              number,
              string,
            ];
            const unit = state.units.find((entry) => entry.runId === runId && entry.unitNumber === unitNumber && entry.candidateKey === candidateKey);
            if (unit) {
              unit.status = status;
              unit.width = width;
              unit.height = height;
              unit.contentHash = contentHash;
              unit.errorCode = errorCode;
              unit.error = error;
              unit.processedAt = processedAt;
              unit.deletedAt = deletedAt;
            }
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_call_limit = MAX")) {
            const [callLimit, reservationUsd, updatedAt, runId] = params as [number, number, string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              normalizeVisionRunState(run);
              run.visionCallLimit = Math.max(run.visionCallLimit ?? 80, callLimit);
              run.visionReservationUsd = Math.max(run.visionReservationUsd ?? 0, reservationUsd);
              run.visionBudgetReserved = 0;
              run.visionReservationId = null;
              run.visionReservationJobId = null;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("SET vision_budget_reserved = 1")) {
            const [reservationId, researchJobId, updatedAt, runId] = params as [string, string, string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            const active = state.reservations.some((reservation) =>
              reservation.id === reservationId
              && reservation.researchJobId === researchJobId
              && reservation.status === "RESERVED"
            );
            if (run && active) {
              normalizeVisionRunState(run);
              run.visionBudgetReserved = 1;
              run.visionReservationId = reservationId;
              run.visionReservationJobId = researchJobId;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run && active ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_slots_used = vision_slots_used + 1")) {
            const [updatedAt, runId] = params as [string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (!run) return { success: true, meta: { changes: 0 } };
            normalizeVisionRunState(run);
            const active = state.reservations.some((reservation) =>
              reservation.id === run.visionReservationId
              && reservation.researchJobId === run.visionReservationJobId
              && reservation.status === "RESERVED"
            );
            if (run.visionBudgetReserved !== 1 || !active || (run.visionSlotsUsed ?? 0) >= (run.visionCallLimit ?? 80)) {
              return { success: true, meta: { changes: 0 } };
            }
            run.visionSlotsUsed = (run.visionSlotsUsed ?? 0) + 1;
            run.updatedAt = updatedAt;
            return { success: true, meta: { changes: 1 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_attempted = vision_attempted + 1")) {
            const [updatedAt, runId] = params as [string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              normalizeVisionRunState(run);
              run.visionAttempted = (run.visionAttempted ?? 0) + 1;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_cap_blocked = vision_cap_blocked + 1")) {
            const [updatedAt, runId] = params as [string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              normalizeVisionRunState(run);
              run.visionBlocked = (run.visionBlocked ?? 0) + 1;
              run.visionCapBlocked = (run.visionCapBlocked ?? 0) + 1;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_budget_blocked = vision_budget_blocked + 1")) {
            const [updatedAt, runId] = params as [string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              normalizeVisionRunState(run);
              run.visionBlocked = (run.visionBlocked ?? 0) + 1;
              run.visionBudgetBlocked = (run.visionBudgetBlocked ?? 0) + 1;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_completed = vision_completed + 1")) {
            const [updatedAt, runId] = params as [string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              normalizeVisionRunState(run);
              run.visionCompleted = (run.visionCompleted ?? 0) + 1;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs") && query.includes("vision_failed = vision_failed + 1")) {
            const [updatedAt, runId] = params as [string, string];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              normalizeVisionRunState(run);
              run.visionFailed = (run.visionFailed ?? 0) + 1;
              run.updatedAt = updatedAt;
            }
            return { success: true, meta: { changes: run ? 1 : 0 } };
          }

          if (query.includes("UPDATE visual_extraction_runs")) {
            const [status, totalUnits, uploadedUnits, processedUnits, selectedCount, reviewCount, filteredCount, unavailableCount, errorCode, error, updatedAt, finishedAt, runId] = params as [
              string,
              number,
              number,
              number,
              number,
              number,
              number,
              number,
              string | null,
              string | null,
              string,
              string | null,
              string,
            ];
            const run = state.runs.find((entry) => entry.id === runId);
            if (run) {
              run.status = status;
              run.totalUnits = totalUnits;
              run.uploadedUnits = uploadedUnits;
              run.processedUnits = processedUnits;
              run.selectedCount = selectedCount;
              run.reviewCount = reviewCount;
              run.filteredCount = filteredCount;
              run.unavailableCount = unavailableCount;
              run.errorCode = errorCode;
              run.error = error;
              run.updatedAt = updatedAt;
              run.finishedAt = finishedAt;
            }
          }

          return { success: true, meta: { changes: 1 } };
        },
        async all<T = unknown>() {
          if (query.includes("FROM visual_extraction_units") && query.includes("WHERE run_id = ?")) {
            const [runId] = params as [string];
            const results = state.units
              .filter((unit) => unit.runId === runId)
              .sort((left, right) => left.unitNumber - right.unitNumber) as T[];
            return { results };
          }
          if (query.includes("FROM visual_extraction_units") && query.includes("temp_r2_key IS NOT NULL") && query.includes("status IN ('UPLOADED', 'FAILED')")) {
            const [olderThan] = params as [string];
            const results = state.units
              .filter((unit) => unit.tempR2Key && unit.deletedAt == null && (unit.status === "UPLOADED" || unit.status === "FAILED") && unit.createdAt < olderThan)
              .sort((left, right) => left.createdAt.localeCompare(right.createdAt)) as T[];
            return { results };
          }
          if (query.includes("FROM visual_extraction_units") && query.includes("temp_r2_key IS NOT NULL")) {
            const results = state.units
              .filter((unit) => unit.tempR2Key && unit.deletedAt == null && unit.status !== "DELETED")
              .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
              .map((unit) => {
                const run = state.runs.find((entry) => entry.id === unit.runId);
                return {
                  unitId: unit.id,
                  runId: unit.runId,
                  sourceId: run?.parentSourceId,
                  versionId: run?.parentVersionId,
                  unitNumber: unit.unitNumber,
                  tempR2Key: unit.tempR2Key,
                  runStatus: run?.status,
                  finishedAt: run?.finishedAt,
                  updatedAt: run?.updatedAt,
                };
              }) as T[];
            return { results };
          }
          return { results: [] as T[] };
        },
      } as D1PreparedStatement;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<T[]> {
      const results: T[] = [];
      for (const statement of statements) {
        results.push(await statement.run() as T);
      }
      return results;
    },
    state,
  } as D1Database & { state: { runs: RunState[]; units: UnitState[] } };

  return db;
}
