import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});

describe("ExtractionStore", () => {
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
};

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

function createExtractionDb(seed: {
  runs?: RunState[];
  units?: UnitState[];
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
    runs: [...(seed.runs ?? [])],
    units: [...(seed.units ?? [])],
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
            const [id, parentSourceId, parentVersionId, originKind, status, totalUnits, uploadedUnits, processedUnits, selectedCount, reviewCount, filteredCount, unavailableCount, errorCode, error, createdAt, updatedAt, finishedAt] = params as [
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
            ];

            if (
              seed.simulateRunInsertRace &&
              !query.includes("INSERT OR IGNORE") &&
              seed.simulateRunInsertRace.parentSourceId === parentSourceId &&
              seed.simulateRunInsertRace.parentVersionId === parentVersionId &&
              seed.simulateRunInsertRace.originKind === originKind
            ) {
              state.runs.push({
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
              });
              throw new Error("UNIQUE constraint failed: visual_extraction_runs.parent_version_id, visual_extraction_runs.origin_kind");
            }
            if (
              seed.simulateRunInsertRace &&
              query.includes("INSERT OR IGNORE") &&
              seed.simulateRunInsertRace.parentSourceId === parentSourceId &&
              seed.simulateRunInsertRace.parentVersionId === parentVersionId &&
              seed.simulateRunInsertRace.originKind === originKind
            ) {
              state.runs.push({
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
              });
              delete seed.simulateRunInsertRace;
              return { success: true, meta: { changes: 0 } };
            }
            if (
              query.includes("INSERT OR IGNORE") &&
              state.runs.some((entry) => entry.parentVersionId === parentVersionId && entry.originKind === originKind && ["UPLOADING", "QUEUED", "RUNNING"].includes(entry.status))
            ) {
              return { success: true, meta: { changes: 0 } };
            }
            state.runs.push({
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
            });
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
          if (query.includes("FROM visual_extraction_units") && query.includes("temp_r2_key IS NOT NULL")) {
            const [olderThan] = params as [string];
            const results = state.units
              .filter((unit) => unit.tempR2Key && unit.deletedAt == null && (unit.status === "UPLOADED" || unit.status === "FAILED") && unit.createdAt < olderThan)
              .sort((left, right) => left.createdAt.localeCompare(right.createdAt)) as T[];
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
