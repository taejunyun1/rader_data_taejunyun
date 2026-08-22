import { uuid } from "../ingestion/ids";
import { callOpenAi } from "../lib/openai";
import { chunkText, extractJson, deepChunkPrompt, deepSynthesisPrompt, keepVerbatimQuotes, type DeepAnalysisPayload, type DeepChunkResult, validateDeepPayload } from "./deepPrompt";
import { modelTierForDeepStage, profileFor } from "./deepProfiles";

export async function analyzeDeepSource(env: Env, sourceId: string, requestedProfile: unknown): Promise<{ analysisId: string; payload: DeepAnalysisPayload; model: string; costUsd: number }> {
  const profile = profileFor(requestedProfile);
  const row = await env.DB.prepare(
    `SELECT s.title, v.normalized_text, v.extracted_text
     FROM sources s LEFT JOIN source_versions v ON v.id = s.active_version_id
     WHERE s.id = ?`
  ).bind(sourceId).first<{ title: string; normalized_text: string | null; extracted_text: string | null }>();
  if (!row) throw new Error("source_not_found");
  const sourceText = (row.normalized_text ?? row.extracted_text ?? "").trim();
  if (sourceText.length < 40) throw new Error("deep_analysis_text_missing");

  const chunks = chunkText(sourceText, 24_000, Math.ceil(profile.maxChars / 24_000)).slice(0, 4);
  const chunkResults = await Promise.all(chunks.map(async (chunk, index) => {
    const result = await callOpenAi(env, {
      purpose: "deep_analysis",
      model: modelTierForDeepStage("chunk"),
      jsonMode: true,
      maxOutputTokens: 2600,
      messages: [
        { role: "system", content: "You are a careful long-form research reader. Output only valid JSON." },
        { role: "user", content: deepChunkPrompt(chunk, index, chunks.length) },
      ],
    });
    const parsed = parseChunk(extractJson(result.text));
    if (!parsed) throw new Error("deep_analysis_chunk_invalid");
    return { parsed, costUsd: result.costUsd, model: result.model };
  }));

  const synthesis = await callOpenAi(env, {
    purpose: "deep_analysis",
    model: modelTierForDeepStage("synthesis"),
    jsonMode: true,
    maxOutputTokens: 4200,
    messages: [
      { role: "system", content: "You are a precise long-form research editor. Output only valid JSON." },
      { role: "user", content: deepSynthesisPrompt(chunkResults.map((item) => item.parsed), profile.id, sourceText.length, chunks.join("\n").length) },
    ],
  });
  const raw = validateDeepPayload(extractJson(synthesis.text), profile.id, sourceText.length, chunks.join("\n").length, chunks.length);
  if (!raw) throw new Error("deep_analysis_invalid_output");
  const payload = keepVerbatimQuotes(raw, sourceText);
  const ts = new Date().toISOString();
  const analysisId = uuid();
  await env.DB.prepare(
    `INSERT INTO source_analysis (id, source_id, version_id, analysis_type, provenance, model, prompt_version, payload_json, cost_usd, created_at)
     SELECT ?, ?, active_version_id, 'deep', 'INTERPRETATION', ?, 'deep-v1', ?, ?, ? FROM sources WHERE id = ?`
  ).bind(analysisId, sourceId, synthesis.model, JSON.stringify(payload), chunkResults.reduce((sum, item) => sum + item.costUsd, 0) + synthesis.costUsd, ts, sourceId).run();
  return { analysisId, payload, model: synthesis.model, costUsd: chunkResults.reduce((sum, item) => sum + item.costUsd, 0) + synthesis.costUsd };
}

function parseChunk(raw: unknown): DeepChunkResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const strings = (input: unknown, max: number): string[] => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 500)).slice(0, max)
    : [];
  const args = Array.isArray(value.arguments) ? value.arguments.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const claim = typeof (item as Record<string, unknown>).claim === "string" ? String((item as Record<string, unknown>).claim).trim().slice(0, 800) : "";
    return claim ? [{ claim, evidence: strings((item as Record<string, unknown>).evidence, 4) }] : [];
  }).slice(0, 8) : [];
  return {
    overview: typeof value.overview === "string" ? value.overview.trim().slice(0, 3000) : "",
    arguments: args,
    structure: strings(value.structure, 8),
    quotes: strings(value.quotes, 8),
    concepts: strings(value.concepts, 12),
    uncertainties: strings(value.uncertainties, 8),
  };
}
