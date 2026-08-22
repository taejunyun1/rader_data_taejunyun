const EMBED_MODEL = "@cf/baai/bge-m3";
const MAX_EMBED_CHARS = 4000;

export function embedText(env: Env, text: string): Promise<number[]> {
  const truncated = text.slice(0, MAX_EMBED_CHARS);
  return env.AI
    .run(EMBED_MODEL, { text: [truncated] })
    .then((r) => {
      const data = (r as unknown as { data?: number[][] }).data;
      if (data?.[0]?.length) return data[0];
      throw new Error("embed_empty_result");
    })
    .catch((e: Error) => {
      throw new Error(`embed_failed: ${e.message}`);
    });
}

export async function ensureEmbedding(env: Env, sourceId: string): Promise<boolean> {
  const existing = await env.DB
    .prepare("SELECT source_id FROM source_embeddings WHERE source_id = ?")
    .bind(sourceId)
    .first();
  if (existing) return false;

  const rows = await env.DB
    .prepare(
      `SELECT COALESCE(v.normalized_text, v.extracted_text) AS extracted_text, s.title,
              (SELECT payload_json FROM source_analysis a WHERE a.source_id = s.id ORDER BY a.created_at DESC LIMIT 1) AS analysis
       FROM sources s JOIN source_versions v ON v.id = s.active_version_id
       WHERE s.id = ?`
    )
    .bind(sourceId)
    .first<{ extracted_text: string | null; title: string; analysis: string | null }>();
  if (!rows) return false;

  let summary = "";
  try {
    const a = JSON.parse(rows.analysis ?? "{}") as { summary?: string };
    summary = a.summary ?? "";
  } catch {
    summary = "";
  }
  const text = `${rows.title}\n\n${summary}\n\n${rows.extracted_text ?? ""}`.trim();
  if (text.length < 20) return false;

  const vector = await embedText(env, text);
  await env.VECTOR_INDEX.upsert([
    { id: sourceId, values: vector, metadata: { sourceId, title: rows.title.slice(0, 200) } },
  ]);
  await env.DB
    .prepare("INSERT OR REPLACE INTO source_embeddings (source_id, model, chunk_chars, created_at) VALUES (?, ?, ?, ?)")
    .bind(sourceId, EMBED_MODEL, text.length, new Date().toISOString())
    .run();
  return true;
}

export interface SemanticHit {
  sourceId: string;
  title: string;
  score: number;
}

export async function semanticSearch(env: Env, query: string, topK = 8): Promise<SemanticHit[]> {
  const vector = await embedText(env, query);
  const result = await env.VECTOR_INDEX.query(vector, { topK, returnMetadata: "all" });
  return (result.matches ?? [])
    .filter((m) => (m.score ?? 0) > 0.3)
    .map((m) => ({
      sourceId: String(m.id),
      title: String((m.metadata as { title?: string } | null)?.title ?? ""),
      score: m.score ?? 0,
    }));
}
