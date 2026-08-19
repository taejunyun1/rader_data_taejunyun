import { SOURCE_KINDS, type ProcessingStatus, type SourceKind } from "@radar/shared";
import { analysisPrompt, validateAnalysis, type SourceAnalysisPayload } from "./prompt";
import { inferTopics } from "./topics";
import { ensureEmbedding } from "../lib/embed";
import { uuid } from "../ingestion/ids";

const ANALYSIS_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export interface AnalyzeResult {
  sourceId: string;
  status: "analyzed" | "failed";
  hasAnalysis: boolean;
  error?: string;
}

export async function analyzeSource(env: Env, sourceId: string): Promise<AnalyzeResult> {
  const src = await env.DB
    .prepare("SELECT id, kind, title FROM sources WHERE id = ?")
    .bind(sourceId)
    .first<{ id: string; kind: string; title: string }>();
  if (!src) return { sourceId, status: "failed", hasAnalysis: false, error: "not_found" };

  const version = await env.DB
    .prepare("SELECT id, extracted_text FROM source_versions WHERE source_id = ? ORDER BY version DESC LIMIT 1")
    .bind(sourceId)
    .first<{ id: string; extracted_text: string | null }>();

  const text = version?.extracted_text?.trim();
  if (!text || text.length < 40) {
    await setSourceStatus(env, sourceId, "stored");
    return { sourceId, status: "analyzed", hasAnalysis: false, error: "no_text" };
  }

  try {
    const prompt = analysisPrompt(text, src.kind);
    const aiRes = (await env.AI.run(ANALYSIS_MODEL, {
      messages: [
        { role: "system", content: "You are a precise research analysis engine. Output only valid JSON." },
        { role: "user", content: prompt },
      ],
      max_tokens: 2048,
    })) as unknown;

    let parsed: unknown = aiRes;
    if (parsed && typeof parsed === "object" && typeof (parsed as { response?: string }).response === "string") {
      try {
        parsed = JSON.parse((parsed as { response: string }).response);
      } catch {
        parsed = extractJson((parsed as { response: string }).response);
      }
    }
    const payload = validateAnalysis(parsed);

    const ts = new Date().toISOString();
    if (payload) {
      await persistAnalysis(env, {
        sourceId,
        versionId: version?.id ?? null,
        payload,
        model: ANALYSIS_MODEL,
        ts,
      });
      await applyClassification(env, sourceId, payload, src.kind as SourceKind);
      await applyTopics(env, sourceId, payload);
      await indexAnalysis(env, sourceId, payload, ts);
      await ensureEmbedding(env, sourceId).catch((e: Error) =>
        console.warn(JSON.stringify({ level: "warn", scope: "embed", sourceId, message: e.message }))
      );
      await setSourceStatus(env, sourceId, "indexed");
      return { sourceId, status: "analyzed", hasAnalysis: true };
    }

    await setJobError(env, sourceId, "analysis_invalid_output");
    await setSourceStatus(env, sourceId, "extracted");
    return { sourceId, status: "failed", hasAnalysis: false, error: "analysis_invalid_output" };
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    await setJobError(env, sourceId, message);
    return { sourceId, status: "failed", hasAnalysis: false, error: message };
  }
}

async function persistAnalysis(
  env: Env,
  a: { sourceId: string; versionId: string | null; payload: SourceAnalysisPayload; model: string; ts: string }
) {
  await env.DB
    .prepare(
      `INSERT INTO source_analysis (id, source_id, version_id, analysis_type, provenance, model, prompt_version, payload_json, cost_usd, created_at)
       VALUES (?, ?, ?, 'basic', 'INTERPRETATION', ?, 'v1', ?, 0, ?)`
    )
    .bind(uuid(), a.sourceId, a.versionId, a.model, JSON.stringify(a.payload), a.ts)
    .run();
}

async function applyClassification(env: Env, sourceId: string, payload: SourceAnalysisPayload, currentKind: SourceKind) {
  const cls = payload.classification;
  if (!cls) return;
  let kind = currentKind;
  if (
    cls.suggestedKind &&
    SOURCE_KINDS.includes(cls.suggestedKind as (typeof SOURCE_KINDS)[number]) &&
    cls.suggestedKind !== currentKind
  ) {
    const trustedOrigins = ["homepage", "upload:pdf", "url"];
    const row = await env.DB.prepare("SELECT origin FROM sources WHERE id = ?").bind(sourceId).first<{ origin: string }>();
    if (row?.origin && trustedOrigins.includes(row.origin) === false) {
      kind = cls.suggestedKind as SourceKind;
    }
  }
  const reliability = cls.reliability === "PRIMARY" || cls.reliability === "SECONDARY" || cls.reliability === "DISCOVERY" ? cls.reliability : null;
  await env.DB
    .prepare("UPDATE sources SET kind = ?, reliability = COALESCE(?, reliability), updated_at = ? WHERE id = ?")
    .bind(kind, reliability, new Date().toISOString(), sourceId)
    .run();
}

async function indexAnalysis(env: Env, sourceId: string, payload: SourceAnalysisPayload, ts: string) {
  const stmts: D1PreparedStatement[] = [];
  for (const kw of payload.keywords ?? []) {
    stmts.push(
      env.DB
        .prepare("INSERT INTO keywords (id, source_id, keyword, weight, created_at) VALUES (?, ?, ?, 1.0, ?)")
        .bind(uuid(), sourceId, kw.toLowerCase(), ts)
    );
  }
  for (const q of payload.questions ?? []) {
    stmts.push(
      env.DB
        .prepare("INSERT INTO questions (id, source_id, question, status, created_at) VALUES (?, ?, ?, 'OPEN', ?)")
        .bind(uuid(), sourceId, q, ts)
    );
  }
  for (const f of payload.important_fragments ?? []) {
    stmts.push(
      env.DB
        .prepare("INSERT INTO fragments (id, source_id, text, context_json, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(uuid(), sourceId, f, JSON.stringify({ provenance: "SOURCE" }), ts)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
}

async function applyTopics(env: Env, sourceId: string, payload: SourceAnalysisPayload): Promise<void> {
  const topics = inferTopics({
    keywords: payload.keywords,
    important_fragments: payload.important_fragments,
    summary: payload.summary,
  });
  const existing = await env.DB.prepare("SELECT topics FROM sources WHERE id = ?").bind(sourceId).first<{ topics: string | null }>();
  let merged: string[] = topics;
  if (existing?.topics) {
    try {
      const prev = JSON.parse(existing.topics) as string[];
      merged = [...new Set([...prev, ...topics])].slice(0, 4);
    } catch {
      merged = topics;
    }
  }
  await env.DB
    .prepare("UPDATE sources SET topics = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(merged), new Date().toISOString(), sourceId)
    .run();
}

async function setSourceStatus(env: Env, sourceId: string, status: ProcessingStatus) {
  const ts = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE sources SET status = ?, updated_at = ? WHERE id = ?").bind(status, ts, sourceId),
    env.DB
      .prepare("UPDATE processing_jobs SET status = ?, error = NULL, updated_at = ? WHERE source_id = ?")
      .bind(status, ts, sourceId),
  ]);
}

async function setJobError(env: Env, sourceId: string, error: string) {
  await env.DB
    .prepare("UPDATE processing_jobs SET status = 'failed', error = ?, updated_at = ? WHERE source_id = ?")
    .bind(error.slice(0, 500), new Date().toISOString(), sourceId)
    .run();
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
