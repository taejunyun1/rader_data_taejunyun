import type { CurrentResearchPayload, HomepagePreviewResponse, HomepagePublishResponse, HomepagePublicationStatusResponse, HomepageWithdrawResponse } from "@radar/shared";
import { acquirePublicationLeaseController, createD1PublicationLeaseBackend, type PublicationLeaseController } from "./lease";
import { buildHomepageProjection, loadLatestPublishableDistill, loadPublishableDistill, type HomepageProjectionDraft } from "./projection";
import { allocatePublicationEventAt, beginPublishing, beginWithdrawal, clearPendingWithdrawal, finalizePublished, finalizeWithdrawn, type ReconcileResult } from "./ledger";
import { compareAndSwapCurrent, putHistoryEventIfAbsent, readCurrentPublication, type CurrentPublicationSnapshot } from "./storage";
import type { PublicationLease } from "./lease";

type PublicationEnv = Pick<Env, "DB" | "PUBLICATIONS">;
type Defer = (work: Promise<unknown>) => void;

type LedgerRow = {
  id: string;
  distill_session_id: string;
  status: string;
  payload_json: string | null;
  content_hash: string;
  error_code: string | null;
  pending_action: "PUBLISH" | "REPUBLISH" | "WITHDRAW" | null;
  pending_actor_sub: string | null;
  pending_event_at: string | null;
};

type ExistingCurrentSnapshot = Extract<CurrentPublicationSnapshot, { exists: true }>;
type ExploringSnapshot = ExistingCurrentSnapshot & {
  wrapper: { payload: Extract<CurrentResearchPayload, { state: "EXPLORING" }> };
};

const noopDefer: Defer = () => undefined;

export class HomepagePublicationServiceError extends Error {
  constructor(readonly code: string, readonly status = 409, details?: unknown) { super(code, details === undefined ? undefined : { cause: details }); this.name = "HomepagePublicationServiceError"; }
}

function toPreview(draft: HomepageProjectionDraft, current: CurrentPublicationSnapshot): HomepagePreviewResponse {
  return {
    sessionId: draft.sessionId,
    distilledAt: draft.distilledAt,
    contentHash: draft.contentHash,
    content: draft.content,
    currentRevision: current.currentRevision,
    changed: !current.exists || current.wrapper.payload.state !== "EXPLORING" || current.wrapper.payload.contentHash !== draft.contentHash,
    excludedResearchMaterialCount: draft.excludedResearchMaterialCount,
    privateReview: draft.privateReview,
  };
}

async function acquire(env: PublicationEnv): Promise<{ controller: PublicationLeaseController; release: () => Promise<boolean> }> {
  const backend = createD1PublicationLeaseBackend(env.DB);
  let controller: PublicationLeaseController;
  try { controller = await acquirePublicationLeaseController(backend); } catch (error) {
    if ((error as Error).message === "publication_in_progress") throw new HomepagePublicationServiceError("publication_in_progress");
    throw error;
  }
  return { controller, release: () => backend.release(controller.currentLease()) };
}

async function draftFor(env: PublicationEnv, sessionId: string): Promise<HomepageProjectionDraft> {
  const session = await loadPublishableDistill(env.DB, sessionId);
  if (!session) throw new HomepagePublicationServiceError("publication_session_unavailable", 404);
  return buildHomepageProjection(env.DB, session);
}

function serviceError(error: unknown, fallback = "publication_ledger_unavailable"): HomepagePublicationServiceError {
  if (error instanceof HomepagePublicationServiceError) return error;
  const code = error instanceof Error ? error.message : "";
  if (code === "publication_in_progress") return new HomepagePublicationServiceError(code);
  if (code === "source_delete_in_progress") return new HomepagePublicationServiceError(code, 409);
  return new HomepagePublicationServiceError(fallback, 503);
}

async function ledgerRow(db: D1Database, publicationId: string): Promise<LedgerRow | null> {
  try {
    return await db.prepare("SELECT id,distill_session_id,status,payload_json,content_hash,error_code,pending_action,pending_actor_sub,pending_event_at FROM homepage_publications WHERE id=?")
      .bind(publicationId).first<LedgerRow>();
  } catch (error) {
    throw serviceError(error);
  }
}

function isExploring(current: CurrentPublicationSnapshot): current is ExploringSnapshot {
  return current.exists && current.wrapper.payload.state === "EXPLORING";
}

function isMatchingExploring(current: CurrentPublicationSnapshot, row: LedgerRow): current is ExploringSnapshot {
  return isExploring(current) && current.wrapper.payload.publicationId === row.id && current.wrapper.payload.contentHash === row.content_hash;
}

function isMatchingTombstone(current: CurrentPublicationSnapshot, row: LedgerRow): current is ExistingCurrentSnapshot {
  return current.exists && current.wrapper.payload.state === "WITHDRAWN" &&
    current.wrapper.payload.withdrawnPublicationId === row.id && current.wrapper.payload.withdrawnContentHash === row.content_hash;
}

async function guardedBatch(db: D1Database, controller: PublicationLeaseController, statements: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
  await controller.checkpoint();
  const results = await db.batch(statements);
  await controller.checkpoint();
  return results;
}

async function repairMatchingPublish(
  env: PublicationEnv,
  controller: PublicationLeaseController,
  row: LedgerRow,
  current: ExploringSnapshot,
): Promise<boolean> {
  const payload = current.wrapper.payload;
  if (row.pending_action !== "PUBLISH" && row.pending_action !== "REPUBLISH") {
    if (row.status === "PUBLISHED" && row.payload_json === JSON.stringify(payload)) return false;
    const eventAt = await allocatePublicationEventAt(env.DB, controller.currentLease(), row.id, payload.updatedAt);
    const update = env.DB.prepare(`UPDATE homepage_publications
      SET status='PUBLISHED',payload_json=?,first_published_at=COALESCE(first_published_at,?),last_published_at=?,approved_at=COALESCE(approved_at,?),
          pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,error_code=NULL,updated_at=?
      WHERE id=? AND status NOT IN ('PURGING','PURGED')`).bind(
      JSON.stringify(payload), payload.publishedAt, payload.updatedAt, payload.publishedAt, new Date().toISOString(), row.id,
    );
    const event = env.DB.prepare("INSERT OR IGNORE INTO homepage_publication_events(id,publication_id,action,actor_sub,occurred_at) VALUES(?,?,?,?,?)")
      .bind(crypto.randomUUID(), row.id, "RECONCILE", "system:reconciler", eventAt);
    const result = await guardedBatch(env.DB, controller, [event, update]);
    if (!result[1]?.meta.changes) throw new Error("publication_ledger_unavailable");
    return true;
  }
  if (!row.pending_event_at || !row.pending_actor_sub) throw new Error("publication_ledger_unavailable");
  const action = row.pending_action === "PUBLISH" ? "PUBLISH" : "REPUBLISH";
  const event = env.DB.prepare("INSERT OR IGNORE INTO homepage_publication_events(id,publication_id,action,actor_sub,occurred_at) VALUES(?,?,?,?,?)")
    .bind(crypto.randomUUID(), row.id, action, row.pending_actor_sub, row.pending_event_at);
  const update = env.DB.prepare(`UPDATE homepage_publications
    SET status='PUBLISHED',payload_json=?,approved_by_sub=pending_actor_sub,approved_at=pending_event_at,
        first_published_at=COALESCE(first_published_at,?),last_published_at=?,pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,error_code=NULL,updated_at=?
    WHERE id=? AND pending_action=? AND pending_actor_sub=? AND pending_event_at=?`).bind(
    JSON.stringify(payload), payload.publishedAt, payload.updatedAt, new Date().toISOString(), row.id, row.pending_action, row.pending_actor_sub, row.pending_event_at,
  );
  const result = await guardedBatch(env.DB, controller, [event, update]);
  if (!result[1]?.meta.changes) throw new Error("publication_ledger_unavailable");
  return true;
}

async function repairMatchingWithdrawal(
  env: PublicationEnv,
  controller: PublicationLeaseController,
  row: LedgerRow,
  current: ExistingCurrentSnapshot,
): Promise<boolean> {
  const payload = current.wrapper.payload;
  if (payload.state !== "WITHDRAWN") return false;
  if (row.pending_action === "WITHDRAW") {
    if (!row.pending_event_at || !row.pending_actor_sub) throw new Error("publication_ledger_unavailable");
    const event = env.DB.prepare("INSERT OR IGNORE INTO homepage_publication_events(id,publication_id,action,actor_sub,occurred_at) VALUES(?,?,?,?,?)")
      .bind(crypto.randomUUID(), row.id, "WITHDRAW", row.pending_actor_sub, row.pending_event_at);
    const update = env.DB.prepare(`UPDATE homepage_publications
      SET status='WITHDRAWN',withdrawn_by_sub=pending_actor_sub,withdrawn_at=pending_event_at,payload_json=?,pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,error_code=NULL,updated_at=?
      WHERE id=? AND pending_action='WITHDRAW' AND pending_actor_sub=? AND pending_event_at=?`).bind(
      JSON.stringify(payload), new Date().toISOString(), row.id, row.pending_actor_sub, row.pending_event_at,
    );
    const result = await guardedBatch(env.DB, controller, [event, update]);
    if (!result[1]?.meta.changes) throw new Error("publication_ledger_unavailable");
    return true;
  }
  if (row.status === "WITHDRAWN" && row.payload_json === JSON.stringify(payload)) return false;
  const eventAt = await allocatePublicationEventAt(env.DB, controller.currentLease(), row.id, payload.withdrawnAt);
  const event = env.DB.prepare("INSERT OR IGNORE INTO homepage_publication_events(id,publication_id,action,actor_sub,occurred_at) VALUES(?,?,?,?,?)")
    .bind(crypto.randomUUID(), row.id, "RECONCILE", "system:reconciler", eventAt);
  const update = env.DB.prepare(`UPDATE homepage_publications
    SET status='WITHDRAWN',payload_json=?,withdrawn_by_sub=COALESCE(withdrawn_by_sub,'system:reconciler'),withdrawn_at=COALESCE(withdrawn_at,?),pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,error_code=NULL,updated_at=?
    WHERE id=? AND status NOT IN ('PURGING','PURGED')`).bind(
    JSON.stringify(payload), payload.withdrawnAt, new Date().toISOString(), row.id,
  );
  const result = await guardedBatch(env.DB, controller, [event, update]);
  if (!result[1]?.meta.changes) throw new Error("publication_ledger_unavailable");
  return true;
}

async function reconcileCurrentLedger(env: PublicationEnv, controller: PublicationLeaseController, current: CurrentPublicationSnapshot): Promise<ReconcileResult> {
  await controller.checkpoint();
  const rows = await env.DB.prepare("SELECT id,distill_session_id,status,payload_json,content_hash,error_code,pending_action,pending_actor_sub,pending_event_at FROM homepage_publications ORDER BY updated_at").all<LedgerRow>();
  let repaired = 0;
  let failed = 0;
  for (const row of rows.results ?? []) {
    if (row.status === "PURGING" || row.status === "PURGED") continue;
    if (isMatchingExploring(current, row)) {
      if (row.pending_action === "WITHDRAW") {
        await clearPendingWithdrawal(env.DB, controller.currentLease(), row.id);
        repaired++;
      } else if (await repairMatchingPublish(env, controller, row, current)) repaired++;
      continue;
    }
    if (isMatchingTombstone(current, row)) {
      if (await repairMatchingWithdrawal(env, controller, row, current)) repaired++;
      continue;
    }
    if (row.pending_action === "WITHDRAW") {
      await clearPendingWithdrawal(env.DB, controller.currentLease(), row.id);
      repaired++;
    }
    if (row.status === "PUBLISHING") {
      await controller.checkpoint();
      const result = await env.DB.prepare("UPDATE homepage_publications SET status='FAILED',error_code='reconcile_current_mismatch',updated_at=? WHERE id=? AND status='PUBLISHING'")
        .bind(new Date().toISOString(), row.id).run();
      if (result.meta.changes) failed++;
    } else if (row.status === "PUBLISHED" && current.exists) {
      await controller.checkpoint();
      const result = await env.DB.prepare("UPDATE homepage_publications SET status='SUPERSEDED',superseded_at=COALESCE(superseded_at,?),updated_at=? WHERE id=? AND status='PUBLISHED'")
        .bind(new Date().toISOString(), new Date().toISOString(), row.id).run();
      if (result.meta.changes) repaired++;
    } else if (row.status === "PUBLISHED" && !current.exists) {
      await controller.checkpoint();
      const result = await env.DB.prepare("UPDATE homepage_publications SET status='FAILED',error_code='reconcile_current_missing',updated_at=? WHERE id=? AND status='PUBLISHED'")
        .bind(new Date().toISOString(), row.id).run();
      if (result.meta.changes) failed++;
    }
  }
  return { scanned: rows.results?.length ?? 0, repaired, failed };
}

async function deferRepairAfterRelease(env: PublicationEnv, releasePromise: Promise<void>, defer: Defer): Promise<void> {
  const repair = releasePromise.then(() => repairHomepagePublicationLedger(env)).catch(() => undefined);
  try { defer(repair); } catch { await repair; }
}

export async function previewHomepagePublication(env: PublicationEnv, sessionId: string): Promise<HomepagePreviewResponse> {
  const draft = await draftFor(env, sessionId);
  return toPreview(draft, await readCurrentPublication(env.PUBLICATIONS));
}

export async function publishHomepagePublication(
  env: PublicationEnv,
  input: { sessionId: string; expectedContentHash: string; expectedCurrentRevision: string; actorSub: string; defer: Defer },
): Promise<HomepagePublishResponse> {
  const { controller, release } = await acquire(env);
  let released = false;
  const safeRelease = async () => { if (released) return; released = true; await controller.stop(); await release(); };
  try {
    await controller.checkpoint();
    let current = await readCurrentPublication(env.PUBLICATIONS);
    await reconcileCurrentLedger(env, controller, current);
    const draft = await draftFor(env, input.sessionId);
    if (draft.contentHash !== input.expectedContentHash) throw new HomepagePublicationServiceError("publication_preview_stale", 409);
    if (current.currentRevision !== input.expectedCurrentRevision) {
      if (current.exists && current.wrapper.payload.state === "EXPLORING" && current.wrapper.payload.contentHash === draft.contentHash) {
        const existing = current.wrapper.payload;
        if (existing.distilledAt === draft.distilledAt && existing.contentHash === draft.contentHash) {
          await safeRelease();
          return { ok: true, publication: existing, currentRevision: current.currentRevision, idempotent: true, ledgerReconcilePending: false };
        }
      }
      throw new HomepagePublicationServiceError("publication_current_changed", 409);
    }
    const edition = await beginPublishing(env.DB, controller.currentLease(), { sessionId: input.sessionId, contentHash: draft.contentHash, actorSub: input.actorSub, approvedAt: new Date().toISOString() });
    const publication: CurrentResearchPayload = {
      schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING",
      publicationId: edition.publicationId, distilledAt: draft.distilledAt, publishedAt: edition.publishedAt,
      updatedAt: edition.eventAt, contentHash: draft.contentHash, content: draft.content,
    };
    const previousPublicationId = current.exists && current.wrapper.payload.state === "EXPLORING"
      ? current.wrapper.payload.publicationId
      : null;
    await controller.checkpoint();
    await putHistoryEventIfAbsent(env.PUBLICATIONS, { distillSessionId: input.sessionId, payload: publication as Extract<CurrentResearchPayload, { state: "EXPLORING" }> });
    await controller.checkpoint();
    current = await compareAndSwapCurrent(env.PUBLICATIONS, current, publication);
    await controller.checkpoint();
    await finalizePublished(env.DB, controller.currentLease(), { previousPublicationId, publication: publication as Extract<CurrentResearchPayload, { state: "EXPLORING" }> });
    await safeRelease();
    return { ok: true, publication: publication as Extract<CurrentResearchPayload, { state: "EXPLORING" }>, currentRevision: current.currentRevision, idempotent: false, ledgerReconcilePending: false };
  } catch (error) {
    await safeRelease();
    // A deferred repair must not contend with the lease held by this request.
    // The release is awaited before the promise is handed to waitUntil.
    await deferRepairAfterRelease(env, Promise.resolve(), input.defer);
    if (error instanceof HomepagePublicationServiceError) throw error;
    throw new HomepagePublicationServiceError((error as Error).message || "publication_failed", 500);
  }
}

export async function repairHomepagePublicationLedger(env: PublicationEnv): Promise<{ scanned: number; repaired: number; failed: number; busy: boolean }> {
  let acquired: { controller: PublicationLeaseController; release: () => Promise<boolean> };
  try { acquired = await acquire(env); } catch (error) { if (error instanceof HomepagePublicationServiceError && error.code === "publication_in_progress") return { scanned: 0, repaired: 0, failed: 0, busy: true }; throw error; }
  try { const current = await readCurrentPublication(env.PUBLICATIONS); return { ...(await reconcileCurrentLedger(env, acquired.controller, current)), busy: false }; }
  finally { await acquired.controller.stop(); await acquired.release(); }
}

export async function getHomepagePublicationStatus(env: PublicationEnv, defer: Defer = noopDefer): Promise<HomepagePublicationStatusResponse> {
  const { controller, release } = await acquire(env);
  let released = false;
  const safeRelease = async () => { if (released) return; released = true; await controller.stop(); await release(); };
  let pending = false;
  let current: CurrentPublicationSnapshot;
  try {
    await controller.checkpoint();
    current = await readCurrentPublication(env.PUBLICATIONS);
    try {
      await reconcileCurrentLedger(env, controller, current);
    } catch (error) {
      // R2 is the public truth. A matching ID/hash is enough to expose that
      // truth while a failed private repair is retried after the lease ends;
      // an unproven identity must never be filled with a guessed session ID.
      if (!current.exists) throw serviceError(error);
      const payload = current.wrapper.payload;
      const id = payload.state === "EXPLORING" ? payload.publicationId : payload.withdrawnPublicationId;
      const hash = payload.state === "EXPLORING" ? payload.contentHash : payload.withdrawnContentHash;
      if (!id || !hash) throw serviceError(error);
      const row = await ledgerRow(env.DB, id);
      if (!row || row.content_hash !== hash) throw new HomepagePublicationServiceError("publication_ledger_unavailable", 503);
      pending = true;
    }
    await controller.checkpoint();
    // Re-read after reconciliation so an authoritative tombstone or repaired
    // current is reflected in the returned opaque revision.
    current = await readCurrentPublication(env.PUBLICATIONS);
    let currentStatus: HomepagePublicationStatusResponse["current"] = { state: "NONE" };
    if (current.exists) {
      const payload = current.wrapper.payload;
      if (payload.state === "EXPLORING") {
        const row = await ledgerRow(env.DB, payload.publicationId);
        if (!row || row.content_hash !== payload.contentHash) throw new HomepagePublicationServiceError("publication_ledger_unavailable", 503);
        currentStatus = { state: "PUBLISHED", publicationId: payload.publicationId, distillSessionId: row.distill_session_id, contentHash: payload.contentHash, publishedAt: payload.publishedAt, updatedAt: payload.updatedAt };
      } else if (payload.withdrawnPublicationId !== null) {
        const row = await ledgerRow(env.DB, payload.withdrawnPublicationId);
        if (!row || row.content_hash !== payload.withdrawnContentHash) throw new HomepagePublicationServiceError("publication_ledger_unavailable", 503);
        currentStatus = { state: "WITHDRAWN", publicationId: payload.withdrawnPublicationId, distillSessionId: null, contentHash: payload.withdrawnContentHash, withdrawnAt: payload.withdrawnAt };
      } else {
        currentStatus = { state: "WITHDRAWN", publicationId: null, distillSessionId: null, contentHash: null, withdrawnAt: payload.withdrawnAt };
      }
    }
    const latest = await loadLatestPublishableDistill(env.DB);
    const latestPublishable = latest
      ? { sessionId: latest.id, distilledAt: latest.createdAt, contentHash: (await buildHomepageProjection(env.DB, latest)).contentHash }
      : null;
    const response = { currentRevision: current.currentRevision, current: currentStatus, latestPublishable, ledgerReconcilePending: pending };
    await safeRelease();
    if (pending) await deferRepairAfterRelease(env, Promise.resolve(), defer);
    return response;
  } catch (error) {
    await safeRelease();
    if (error instanceof HomepagePublicationServiceError) throw error;
    throw serviceError(error);
  }
}

export async function withdrawHomepagePublication(
  env: PublicationEnv,
  input: { expectedPublicationId: string; expectedContentHash: string; expectedCurrentRevision: string; actorSub: string; defer: Defer },
): Promise<HomepageWithdrawResponse> {
  const { controller, release } = await acquire(env);
  let released = false;
  const safeRelease = async () => { if (released) return; released = true; await controller.stop(); await release(); };
  let releasePromise: Promise<void> | null = null;
  let tombstoneWritten = false;
  let intent: { publicationId: string; eventAt: string } | null = null;
  let tombstone: Extract<CurrentResearchPayload, { state: "WITHDRAWN" }> | null = null;
  let next: CurrentPublicationSnapshot | null = null;
  try {
    await controller.checkpoint();
    let current = await readCurrentPublication(env.PUBLICATIONS);
    try { await reconcileCurrentLedger(env, controller, current); }
    catch (error) {
      const payload = current.exists ? current.wrapper.payload : null;
      const id = payload?.state === "EXPLORING" ? payload.publicationId : payload?.withdrawnPublicationId;
      const hash = payload?.state === "EXPLORING" ? payload.contentHash : payload?.withdrawnContentHash;
      const row = id && hash ? await ledgerRow(env.DB, id) : null;
      if (!row || row.content_hash !== hash) throw new HomepagePublicationServiceError("publication_ledger_unavailable", 503);
      // Continue only for a current ID/hash proof. R2 remains authoritative
      // while the private repair is deferred.
    }
    current = await readCurrentPublication(env.PUBLICATIONS);
    if (current.exists && current.wrapper.payload.state === "WITHDRAWN") {
      const payload = current.wrapper.payload;
      if (payload.withdrawnPublicationId !== input.expectedPublicationId || payload.withdrawnContentHash !== input.expectedContentHash) {
        throw new HomepagePublicationServiceError("withdrawal_stale", 409);
      }
      const row = await ledgerRow(env.DB, input.expectedPublicationId);
      if (!row || row.content_hash !== input.expectedContentHash) throw new HomepagePublicationServiceError("publication_ledger_unavailable", 503);
      await safeRelease();
      return { ok: true, state: "WITHDRAWN", withdrawnPublicationId: input.expectedPublicationId, withdrawnAt: payload.withdrawnAt, currentRevision: current.currentRevision, idempotent: true, ledgerReconcilePending: false };
    }
    if (!current.exists || current.wrapper.payload.state !== "EXPLORING") throw new HomepagePublicationServiceError("current_research_not_published", 404);
    if (current.wrapper.payload.publicationId !== input.expectedPublicationId || current.wrapper.payload.contentHash !== input.expectedContentHash || current.currentRevision !== input.expectedCurrentRevision) {
      throw new HomepagePublicationServiceError("withdrawal_stale", 409);
    }
    const row = await ledgerRow(env.DB, input.expectedPublicationId);
    if (!row || row.content_hash !== input.expectedContentHash) throw new HomepagePublicationServiceError("publication_ledger_unavailable", 503);
    intent = await beginWithdrawal(env.DB, controller.currentLease(), { publicationId: input.expectedPublicationId, actorSub: input.actorSub, requestedAt: new Date().toISOString() });
    tombstone = { schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "WITHDRAWN", withdrawnPublicationId: current.wrapper.payload.publicationId, withdrawnContentHash: current.wrapper.payload.contentHash, withdrawnAt: intent.eventAt };
    try {
      next = await compareAndSwapCurrent(env.PUBLICATIONS, current, tombstone);
      tombstoneWritten = true;
    } catch (error) {
      const definite = error instanceof Error && error.message === "publication_state_changed";
      let reread: CurrentPublicationSnapshot | null = null;
      try { reread = await readCurrentPublication(env.PUBLICATIONS); } catch { /* preserve ambiguity */ }
      if (reread?.exists && reread.wrapper.payload.state === "WITHDRAWN" && reread.wrapper.payload.withdrawnPublicationId === input.expectedPublicationId && reread.wrapper.payload.withdrawnContentHash === input.expectedContentHash) {
        tombstoneWritten = true;
        next = reread;
      } else {
        if (definite && intent) await clearPendingWithdrawal(env.DB, controller.currentLease(), intent.publicationId);
        throw new HomepagePublicationServiceError(definite ? "withdrawal_stale" : "withdraw_failed", definite ? 409 : 500);
      }
    }
    try {
      await finalizeWithdrawn(env.DB, controller.currentLease(), { publicationId: input.expectedPublicationId });
    } catch {
      // Once the tombstone CAS succeeded, the public operation succeeded. The
      // retained pending actor/time is the recovery proof for reconciliation.
      await safeRelease();
      releasePromise = Promise.resolve();
      await deferRepairAfterRelease(env, releasePromise, input.defer);
      return { ok: true, state: "WITHDRAWN", withdrawnPublicationId: input.expectedPublicationId, withdrawnAt: tombstone!.withdrawnAt, currentRevision: next!.currentRevision, idempotent: false, ledgerReconcilePending: true };
    }
    await safeRelease();
    return { ok: true, state: "WITHDRAWN", withdrawnPublicationId: input.expectedPublicationId, withdrawnAt: tombstone!.withdrawnAt, currentRevision: next!.currentRevision, idempotent: false, ledgerReconcilePending: false };
  } catch (error) {
    await safeRelease();
    releasePromise = Promise.resolve();
    if (tombstoneWritten && tombstone && next) {
      await deferRepairAfterRelease(env, releasePromise, input.defer);
      return { ok: true, state: "WITHDRAWN", withdrawnPublicationId: input.expectedPublicationId, withdrawnAt: tombstone.withdrawnAt, currentRevision: (next as ExistingCurrentSnapshot).currentRevision, idempotent: false, ledgerReconcilePending: true };
    }
    if (error instanceof HomepagePublicationServiceError) throw error;
    throw serviceError(error, "withdraw_failed");
  }
}
