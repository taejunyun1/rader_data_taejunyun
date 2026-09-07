import type { CurrentResearchPayload } from '@radar/shared';
import type { PublicationLeaseController } from './lease';
import { reconcileCurrentLedger } from './service';
import { readCurrentPublication, type CurrentPublicationSnapshot } from './storage';

/** Resolve source usage from the private session, including excluded materials. */
export async function prepareSourceDeletionFence(
  env: Pick<Env, 'DB' | 'PUBLICATIONS'>,
  controller: PublicationLeaseController,
  sourceId: string,
): Promise<{ current: CurrentPublicationSnapshot; payload: CurrentResearchPayload }> {
  await controller.checkpoint();
  const current = await readCurrentPublication(env.PUBLICATIONS);
  if (!current.exists) {
    const history = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM homepage_publications) +
      (SELECT COUNT(*) FROM homepage_publication_events) AS count`).first<{count: number}>();
    if (!history || history.count !== 0) throw new Error('publication_ledger_unavailable');
  }
  await reconcileCurrentLedger(env, controller, current);
  if (current.exists && current.wrapper.payload.state === 'EXPLORING') {
    const payload = current.wrapper.payload;
    const row = await env.DB.prepare(`SELECT s.sources_used_json FROM homepage_publications p
      JOIN distill_sessions s ON s.id=p.distill_session_id
      WHERE p.id=? AND p.content_hash=?`).bind(payload.publicationId, payload.contentHash).first<{sources_used_json: string}>();
    if (!row) throw new Error('publication_ledger_unavailable');
    let sources: unknown;
    try { sources = JSON.parse(row.sources_used_json); } catch { throw new Error('publication_ledger_unavailable'); }
    if (!Array.isArray(sources) || !sources.length || !sources.every(s => s && typeof s.id === 'string' && s.id)) throw new Error('publication_ledger_unavailable');
    if (sources.some(s => s.id === sourceId)) throw new Error('source_in_publication');
  }
  await controller.checkpoint();
  return { current, payload: current.exists ? current.wrapper.payload : {
    schemaVersion: 1, kind: 'CURRENT_RESEARCH', source: 'research-radar', state: 'WITHDRAWN',
    withdrawnAt: new Date().toISOString(), withdrawnPublicationId: null, withdrawnContentHash: null,
  } };
}
