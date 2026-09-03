import type { CurrentResearchPayload, HomepagePreviewResponse, HomepagePublishResponse } from "@radar/shared";
import { acquirePublicationLeaseController, createD1PublicationLeaseBackend, type PublicationLeaseController } from "./lease";
import { buildHomepageProjection, loadLatestPublishableDistill, loadPublishableDistill, type HomepageProjectionDraft } from "./projection";
import { beginPublishing, finalizePublished, reconcileLedgerToCurrent } from "./ledger";
import { compareAndSwapCurrent, putHistoryEventIfAbsent, readCurrentPublication, type CurrentPublicationSnapshot } from "./storage";

type PublicationEnv = Pick<Env, "DB" | "PUBLICATIONS">;
type Defer = (work: Promise<unknown>) => void;

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
    await reconcileLedgerToCurrent(env.DB, controller.currentLease(), current);
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
    const repair = (async () => { try { await repairHomepagePublicationLedger(env); } catch { /* best effort; ledger remains auditable */ } })();
    try { input.defer(repair); } catch { await repair; }
    await safeRelease();
    if (error instanceof HomepagePublicationServiceError) throw error;
    throw new HomepagePublicationServiceError((error as Error).message || "publication_failed", 500);
  }
}

export async function repairHomepagePublicationLedger(env: PublicationEnv): Promise<{ scanned: number; repaired: number; failed: number; busy: boolean }> {
  let acquired: { controller: PublicationLeaseController; release: () => Promise<boolean> };
  try { acquired = await acquire(env); } catch (error) { if (error instanceof HomepagePublicationServiceError && error.code === "publication_in_progress") return { scanned: 0, repaired: 0, failed: 0, busy: true }; throw error; }
  try { const current = await readCurrentPublication(env.PUBLICATIONS); return { ...(await reconcileLedgerToCurrent(env.DB, acquired.controller.currentLease(), current)), busy: false }; }
  finally { await acquired.controller.stop(); await acquired.release(); }
}
