import type {
  CurrentResearchPayload,
  DistillHomepagePublicationState,
  ExploringCurrentResearchPayload,
  WithdrawnCurrentResearchPayload,
} from "@radar/shared";
import type { CurrentPublicationSnapshot } from "./storage";
import type { PublicationLease } from "./lease";

export interface BeginPublishingInput { sessionId: string; contentHash: string; actorSub: string; approvedAt: string; }
export interface PublishingEdition { publicationId: string; eventAction: "PUBLISH" | "REPUBLISH"; eventAt: string; publishedAt: string; }
export interface FinalizePublishedInput { previousPublicationId: string | null; publication: ExploringCurrentResearchPayload; }
export interface BeginWithdrawalInput { publicationId: string; actorSub: string; requestedAt: string; }
export interface WithdrawalIntent { publicationId: string; eventAt: string; }
export interface FinalizeWithdrawnInput { publicationId: string; }
export interface ReconcileResult { scanned: number; repaired: number; failed: number; }

type LedgerRow = {
  id: string; distill_session_id: string; status: string; payload_json: string | null; content_hash: string;
  error_code: string | null; approved_by_sub: string | null; withdrawn_by_sub: string | null;
  pending_action: "PUBLISH" | "REPUBLISH" | "WITHDRAW" | null; pending_actor_sub: string | null; pending_event_at: string | null;
  created_at: string; updated_at: string; approved_at: string | null; first_published_at: string | null;
  last_published_at: string | null; superseded_at: string | null; withdrawn_at: string | null;
  purge_requested_at: string | null;
};

function iso(value: string): string { const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error("publication_event_time_invalid"); return new Date(time).toISOString(); }
function plusMs(value: string): string { return new Date(Date.parse(value) + 1).toISOString(); }
function requireLease(db: D1Database, lease: PublicationLease): Promise<void> {
  return db.prepare(`WITH clock(now_ms) AS (SELECT COALESCE(CAST(unixepoch('subsec')*1000 AS INTEGER), CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER)))
    UPDATE homepage_publication_lease SET updated_at = updated_at WHERE lock_name='homepage-current-research' AND owner_token=? AND generation=? AND expires_at_ms > (SELECT now_ms FROM clock)`).bind(lease.ownerToken, lease.generation).run().then((result) => { if (!result.meta.changes) throw new Error("publication_lease_guard_failed"); });
}

async function getRow(db: D1Database, publicationId: string): Promise<LedgerRow | null> { return db.prepare("SELECT * FROM homepage_publications WHERE id=?").bind(publicationId).first<LedgerRow>(); }
async function getPair(db: D1Database, sessionId: string, hash: string): Promise<LedgerRow | null> { return db.prepare("SELECT * FROM homepage_publications WHERE distill_session_id=? AND content_hash=?").bind(sessionId, hash).first<LedgerRow>(); }

export async function allocatePublicationEventAt(db: D1Database, lease: PublicationLease, publicationId: string, requestedAt: string): Promise<string> {
  await requireLease(db, lease);
  const requested = iso(requestedAt);
  const row = await getRow(db, publicationId);
  const latest = await db.prepare("SELECT occurred_at FROM homepage_publication_events WHERE publication_id=? ORDER BY occurred_at DESC LIMIT 1").bind(publicationId).first<{ occurred_at: string }>();
  const candidates = [requested, latest?.occurred_at ? plusMs(latest.occurred_at) : requested, row?.pending_event_at ? plusMs(row.pending_event_at) : requested];
  if (row?.superseded_at) candidates.push(plusMs(row.superseded_at));
  if (row?.withdrawn_at) candidates.push(plusMs(row.withdrawn_at));
  return candidates.map(iso).sort((a, b) => a < b ? -1 : a > b ? 1 : 0).at(-1)!;
}

export async function beginPublishing(db: D1Database, lease: PublicationLease, input: BeginPublishingInput): Promise<PublishingEdition> {
  await requireLease(db, lease);
  const requestedAt = iso(input.approvedAt);
  let row = await getPair(db, input.sessionId, input.contentHash);
  if (!row) {
    const id = crypto.randomUUID();
    const eventAt = requestedAt;
    const now = new Date().toISOString();
    const result = await db.prepare(`INSERT INTO homepage_publications
      (id,distill_session_id,status,payload_json,content_hash,approved_by_sub,pending_action,pending_actor_sub,pending_event_at,created_at,updated_at)
      VALUES (?,?, 'PUBLISHING',NULL,?,?, 'PUBLISH',?,?,?,?)`).bind(id, input.sessionId, input.contentHash, input.actorSub, input.actorSub, eventAt, now, now).run();
    if (!result.meta.changes) throw new Error("publication_ledger_unavailable");
    row = await getRow(db, id);
  } else if (["FAILED", "WITHDRAWN", "SUPERSEDED"].includes(row.status) && !row.pending_action) {
    const eventAt = await allocatePublicationEventAt(db, lease, row.id, requestedAt);
    const action = row.first_published_at ? "REPUBLISH" : "PUBLISH";
    await requireLease(db, lease);
    const result = await db.prepare("UPDATE homepage_publications SET status='PUBLISHING', pending_action=?, pending_actor_sub=?, pending_event_at=?, error_code=NULL, updated_at=? WHERE id=? AND status='FAILED' AND pending_action IS NULL").bind(action, input.actorSub, eventAt, new Date().toISOString(), row.id).run();
    if (!result.meta.changes) throw new Error("publication_ledger_unavailable");
    row = await getRow(db, row.id);
  }
  if (!row) throw new Error("publication_ledger_unavailable");
  if (!row.pending_action || (row.pending_action !== "PUBLISH" && row.pending_action !== "REPUBLISH")) throw new Error("publication_in_progress");
  return { publicationId: row.id, eventAction: row.pending_action, eventAt: row.pending_event_at!, publishedAt: row.first_published_at ?? row.pending_event_at! };
}

export async function beginWithdrawal(db: D1Database, lease: PublicationLease, input: BeginWithdrawalInput): Promise<WithdrawalIntent> {
  await requireLease(db, lease);
  const row = await getRow(db, input.publicationId);
  if (!row || !["PUBLISHED", "SUPERSEDED", "FAILED", "WITHDRAWN"].includes(row.status)) throw new Error("publication_not_withdrawable");
  if (row.pending_action === "WITHDRAW") return { publicationId: row.id, eventAt: row.pending_event_at! };
  const eventAt = await allocatePublicationEventAt(db, lease, row.id, input.requestedAt);
  await requireLease(db, lease);
  const result = await db.prepare("UPDATE homepage_publications SET pending_action='WITHDRAW', pending_actor_sub=?, pending_event_at=?, updated_at=? WHERE id=? AND pending_action IS NULL").bind(input.actorSub, eventAt, new Date().toISOString(), input.publicationId).run();
  if (!result.meta.changes) throw new Error("publication_in_progress");
  return { publicationId: input.publicationId, eventAt };
}

export async function clearPendingWithdrawal(db: D1Database, lease: PublicationLease, publicationId: string): Promise<void> {
  await requireLease(db, lease);
  await db.prepare("UPDATE homepage_publications SET pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,updated_at=? WHERE id=? AND pending_action='WITHDRAW'").bind(new Date().toISOString(), publicationId).run();
}

export async function finalizePublished(db: D1Database, lease: PublicationLease, input: FinalizePublishedInput): Promise<void> {
  await requireLease(db, lease);
  const payload = input.publication;
  const row = await getRow(db, payload.publicationId);
  if (!row || !row.pending_action || (row.pending_action !== "PUBLISH" && row.pending_action !== "REPUBLISH") || row.content_hash !== payload.contentHash || row.pending_event_at !== payload.updatedAt || (row.first_published_at ?? row.pending_event_at) !== payload.publishedAt) throw new Error("publication_intent_mismatch");
  const eventAt = row.pending_event_at;
  const action = row.pending_action === "PUBLISH" ? "PUBLISH" : "REPUBLISH";
  const now = new Date().toISOString();
  await requireLease(db, lease);
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO homepage_publication_events(id,publication_id,action,actor_sub,occurred_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), payload.publicationId, action, row.pending_actor_sub ?? "system:reconciler", eventAt),
    db.prepare(`UPDATE homepage_publications SET status='PUBLISHED',payload_json=?,approved_by_sub=pending_actor_sub,approved_at=pending_event_at,
      first_published_at=COALESCE(first_published_at,pending_event_at),last_published_at=pending_event_at,pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,error_code=NULL,updated_at=? WHERE id=? AND pending_action IS NOT NULL`).bind(JSON.stringify(payload), now, payload.publicationId),
  ]);
  if (!results[1]?.meta.changes) throw new Error("publication_ledger_unavailable");
  if (input.previousPublicationId && input.previousPublicationId !== payload.publicationId) {
    await requireLease(db, lease);
    await db.prepare("UPDATE homepage_publications SET status='SUPERSEDED',superseded_at=?,updated_at=? WHERE id=? AND status='PUBLISHED'").bind(eventAt, now, input.previousPublicationId).run();
  }
}

export async function markPublicationFailed(db: D1Database, lease: PublicationLease, publicationId: string, errorCode: string): Promise<void> {
  await requireLease(db, lease);
  const result = await db.prepare("UPDATE homepage_publications SET status='FAILED',error_code=?,updated_at=? WHERE id=? AND status='PUBLISHING'").bind(errorCode, new Date().toISOString(), publicationId).run();
  if (!result.meta.changes) throw new Error("publication_ledger_unavailable");
}

export async function finalizeWithdrawn(db: D1Database, lease: PublicationLease, input: FinalizeWithdrawnInput): Promise<void> {
  await requireLease(db, lease);
  const row = await getRow(db, input.publicationId);
  if (!row || row.pending_action !== "WITHDRAW" || !row.pending_event_at) throw new Error("publication_intent_mismatch");
  const eventAt = row.pending_event_at;
  await requireLease(db, lease);
  const results = await db.batch([
    db.prepare("INSERT OR IGNORE INTO homepage_publication_events(id,publication_id,action,actor_sub,occurred_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(), input.publicationId, "WITHDRAW", row.pending_actor_sub ?? "system:reconciler", eventAt),
    db.prepare("UPDATE homepage_publications SET status='WITHDRAWN',withdrawn_by_sub=pending_actor_sub,withdrawn_at=pending_event_at,pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,updated_at=? WHERE id=? AND pending_action='WITHDRAW'").bind(new Date().toISOString(), input.publicationId),
  ]);
  if (!results[1]?.meta.changes) throw new Error("publication_ledger_unavailable");
}

export async function reconcileLedgerToCurrent(db: D1Database, lease: PublicationLease, current: CurrentPublicationSnapshot): Promise<ReconcileResult> {
  await requireLease(db, lease);
  const rows = await db.prepare("SELECT * FROM homepage_publications WHERE status IN ('PUBLISHING','PUBLISHED','WITHDRAWN','SUPERSEDED','FAILED') ORDER BY updated_at").all<LedgerRow>();
  let repaired = 0; let failed = 0;
  for (const row of rows.results ?? []) {
    if (row.status === "PUBLISHING") {
      const candidate = current.exists && current.wrapper.payload.state === "EXPLORING" ? current.wrapper.payload : null;
      const matches = Boolean(candidate && candidate.publicationId === row.id && candidate.contentHash === row.content_hash);
      await requireLease(db, lease);
      if (matches && candidate) { await db.prepare("UPDATE homepage_publications SET status='PUBLISHED',payload_json=?,first_published_at=COALESCE(first_published_at,?),last_published_at=?,pending_action=NULL,pending_actor_sub=NULL,pending_event_at=NULL,updated_at=? WHERE id=?").bind(JSON.stringify(candidate), candidate.publishedAt, candidate.updatedAt, new Date().toISOString(), row.id).run(); repaired++; }
      else { await db.prepare("UPDATE homepage_publications SET status='FAILED',error_code='reconcile_current_mismatch',updated_at=? WHERE id=?").bind(new Date().toISOString(), row.id).run(); failed++; }
    }
  }
  return { scanned: rows.results?.length ?? 0, repaired, failed };
}

export async function publicationStateForSessions(db: D1Database, sessionIds: string[], current: CurrentPublicationSnapshot | null): Promise<Map<string, DistillHomepagePublicationState>> {
  const out = new Map<string, DistillHomepagePublicationState>();
  for (const id of sessionIds) out.set(id, "NONE");
  if (!sessionIds.length) return out;
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = await db.prepare(`SELECT * FROM homepage_publications WHERE distill_session_id IN (${placeholders}) ORDER BY updated_at DESC`).bind(...sessionIds).all<LedgerRow>();
  for (const row of rows.results ?? []) {
    if (out.get(row.distill_session_id) === "PURGING" || out.get(row.distill_session_id) === "PURGED") continue;
    if (row.status === "PURGING" || row.status === "PURGED") out.set(row.distill_session_id, row.status);
    else if (current?.exists && current.wrapper.payload.state === "EXPLORING" && current.wrapper.payload.publicationId === row.id && current.wrapper.payload.contentHash === row.content_hash) out.set(row.distill_session_id, "CURRENT");
    else if (row.status === "SUPERSEDED" || row.status === "WITHDRAWN" || row.status === "FAILED") out.set(row.distill_session_id, row.status);
  }
  return out;
}
