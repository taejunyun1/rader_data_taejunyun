import type { RadarParams } from "@radar/shared";
import { semanticSearch } from "../lib/embed";

export interface ContextSourceRef {
  id: string;
  title: string;
  kind: string;
  year: number | null;
  summary: string | null;
  fragments: string[];
  signals: string[];
  resurfaced?: boolean;
}

export interface DistillContext {
  keywords: { keyword: string; count: number }[];
  questions: string[];
  sources: ContextSourceRef[];
  recentKeepDevelop: string[];
  params: RadarParams;
}

const MAX_CONTEXT_CHARS = 26_000;

export async function buildDistillContext(env: Env, params: RadarParams): Promise<DistillContext> {
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

  const kwRows = await env.DB.prepare(
    `SELECT keyword, COUNT(*) AS n FROM keywords
     WHERE created_at >= ? GROUP BY keyword ORDER BY n DESC LIMIT 15`
  )
    .bind(sixtyDaysAgo)
    .all<{ keyword: string; n: number }>();

  const qRows = await env.DB.prepare(
    `SELECT q.question FROM questions q
     JOIN sources s ON s.id = q.source_id
     WHERE q.created_at >= ? AND s.status IN ('indexed','analyzed','extracted')
     ORDER BY q.created_at DESC LIMIT 8`
  )
    .bind(sixtyDaysAgo)
    .all<{ question: string }>();

  const signalSources = await env.DB.prepare(
    `SELECT us.source_id AS id, GROUP_CONCAT(DISTINCT us.action) AS actions
     FROM user_signals us
     WHERE us.action IN ('keep','develop','select') AND us.created_at >= ?
     GROUP BY us.source_id
     ORDER BY MAX(us.created_at) DESC LIMIT 8`
  )
    .bind(new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString())
    .all<{ id: string; actions: string }>();

  const signalMap = new Map((signalSources.results ?? []).map((r) => [r.id, r.actions.split(",")]));

  const keywordPattern = (kwRows.results ?? []).slice(0, 8).map((k) => `%${k.keyword}%`);
  let keywordMatches: { id: string }[] = [];
  if (keywordPattern.length) {
    const placeholders = keywordPattern.map(() => "?").join(" OR keyword LIKE ");
    keywordMatches =
      (await env.DB
        .prepare(
          `SELECT DISTINCT k.source_id AS id FROM keywords k
           JOIN sources s ON s.id = k.source_id
           WHERE s.status = 'indexed' AND (keyword LIKE ${placeholders})
           ORDER BY s.updated_at DESC LIMIT 10`
        )
        .bind(...keywordPattern)
        .all<{ id: string }>()).results ?? [];
  }

  const sourceIds = [...new Set([...signalMap.keys(), ...(keywordMatches ?? []).map((m) => m.id)])].slice(0, 12);

  const resurfacedIds = new Set<string>();
  try {
    const momentumQuery = (kwRows.results ?? []).slice(0, 5).map((k) => k.keyword).join(", ");
    if (momentumQuery) {
      const semantic = await semanticSearch(env, momentumQuery, 8);
      for (const hit of semantic) {
        if (sourceIds.length + resurfacedIds.size >= 14) break;
        if (sourceIds.includes(hit.sourceId) || resurfacedIds.has(hit.sourceId)) continue;
        resurfacedIds.add(hit.sourceId);
      }
    }
  } catch {
    /* semantic layer unavailable — keyword-only context */
  }

  const sources: ContextSourceRef[] = [];
  let budget = MAX_CONTEXT_CHARS;
  const allIds = [...sourceIds, ...resurfacedIds];
  for (const id of allIds) {
    const isResurfaced = resurfacedIds.has(id);
    const src = await env.DB
      .prepare("SELECT id, title, kind, year FROM sources WHERE id = ?")
      .bind(id)
      .first<{ id: string; title: string; kind: string; year: number | null }>();
    if (!src) continue;

    const analysis = await env.DB
      .prepare(
        `SELECT payload_json FROM source_analysis WHERE source_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .bind(id)
      .first<{ payload_json: string }>();
    let summary: string | null = null;
    let analysisFragments: string[] = [];
    try {
      const p = analysis ? (JSON.parse(analysis.payload_json) as { summary?: string; important_fragments?: string[] }) : null;
      summary = p?.summary ?? null;
      analysisFragments = p?.important_fragments ?? [];
    } catch {
      summary = null;
    }

    const frags = analysisFragments.slice(0, 2);
    const entry: ContextSourceRef = {
      id: src.id,
      title: src.title,
      kind: src.kind,
      year: src.year,
      summary: summary?.slice(0, 500) ?? null,
      fragments: frags.map((f) => f.slice(0, 200)),
      signals: signalMap.get(id) ?? [],
      resurfaced: isResurfaced || undefined,
    };
    const size = JSON.stringify(entry).length;
    if (size > budget) break;
    budget -= size;
    sources.push(entry);
  }

  const recentKeepDevelop = sources.filter((s) => s.signals.some((a) => a === "keep" || a === "develop")).map((s) => s.title);

  return {
    keywords: (kwRows.results ?? []).slice(0, 12).map((k) => ({ keyword: k.keyword, count: k.n })),
    questions: (qRows.results ?? []).map((r) => r.question),
    sources,
    recentKeepDevelop,
    params,
  };
}
