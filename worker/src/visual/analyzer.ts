import { extractJson } from "../analysis/deepPrompt";
import { embedText } from "../lib/embed";
import { uuid } from "../ingestion/ids";
import type { VisualStorageState } from "@radar/shared";
import { getVisualAsset, getVisualVersionForAnalysis, markVisualProcessingError } from "./store";
import { validateVisualAnalysis, visualAnalysisPrompt, visualAnalysisText, type VisualAnalysisPayload } from "./analysisSchema";
import type { VisualExtractionVisionGate } from "./extraction/visionBudget";
import { withAiCallLedger } from "../lib/aiCallLedger";

interface VisualAnalysisResult {
  visualAssetId: string;
  visualVersionId: string;
  analysisId: string;
  model: string;
  costUsd: number;
  embedded: boolean;
  payload: VisualAnalysisPayload;
}

function base64(bytes: ArrayBuffer): string {
  const input = new Uint8Array(bytes);
  let output = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    output += String.fromCharCode(...input.subarray(offset, Math.min(offset + chunkSize, input.length)));
  }
  return btoa(output);
}

function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["response", "result", "description", "text"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

interface AnalyzeVisualBytesInput {
  visualAssetId: string;
  visualVersionId: string;
  bytes: ArrayBuffer;
  filename?: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  caption: string | null;
  storageState: VisualStorageState;
  visionGate?: VisualExtractionVisionGate;
  researchJobId?: string;
}

export async function analyzeVisualAsset(env: Env, visualAssetId: string, requestedVersionId?: string, researchJobId?: string): Promise<VisualAnalysisResult> {
  const asset = await getVisualAsset(env.DB, visualAssetId);
  if (!asset) throw new Error("visual_asset_not_found");
  const version = requestedVersionId
    ? await getVisualVersionById(env.DB, visualAssetId, requestedVersionId)
    : await getVisualVersionForAnalysis(env.DB, visualAssetId);
  if (!version) throw new Error("visual_version_not_ready");

  const existing = await env.DB.prepare(
    `SELECT id, model_id AS modelId, cost_usd AS costUsd, payload_json AS payloadJson
     FROM visual_analyses
     WHERE visual_asset_id = ? AND visual_version_id = ? AND analysis_type = 'AUTO_SUGGESTION'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(visualAssetId, version.id).first<{ id: string; modelId: string | null; costUsd: number; payloadJson: string }>();
  if (existing) {
    const payload = parseStoredPayload(existing.payloadJson);
    if (payload) {
      await env.DB.prepare("UPDATE visual_assets SET processing_status = 'READY', last_error = NULL, updated_at = ? WHERE id = ?")
        .bind(new Date().toISOString(), visualAssetId).run();
      return {
        visualAssetId,
        visualVersionId: version.id,
        analysisId: existing.id,
        model: existing.modelId ?? env.MODEL_VISION,
        costUsd: Number(existing.costUsd ?? 0),
        embedded: Boolean(await env.DB.prepare("SELECT id FROM visual_embeddings WHERE visual_asset_id = ? AND visual_version_id = ? LIMIT 1").bind(visualAssetId, version.id).first()),
        payload,
      };
    }
  }
  if (!version.r2Key) throw new Error(version.variant === "ORIGINAL" ? "visual_original_not_ready" : "visual_capsule_not_ready");

  await env.DB.prepare("UPDATE visual_assets SET processing_status = 'ANALYZING', last_error = NULL, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), visualAssetId).run();

  try {
    const object = await env.ORIGINALS.get(version.r2Key);
    if (!object) throw new Error("visual_capsule_missing");
    return analyzeVisualVersionBytes(env, {
      visualAssetId,
      visualVersionId: version.id,
      bytes: await object.arrayBuffer(),
      filename: `${visualAssetId}.${version.mimeType.split("/")[1] ?? "img"}`,
      mimeType: version.mimeType,
      width: version.width,
      height: version.height,
      caption: asset.caption,
      storageState: asset.storageState,
      researchJobId,
    });
  } catch (error) {
    await markVisualProcessingError(env.DB, visualAssetId, error instanceof Error ? error.message : "visual_analysis_failed");
    throw error;
  }
}

export async function analyzeVisualVersionBytes(env: Env, input: AnalyzeVisualBytesInput): Promise<VisualAnalysisResult> {
  const payload = await runVisualModel(env, input);
  const analysisId = uuid();
  const timestamp = new Date().toISOString();
  const analysisJson = JSON.stringify(payload);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO visual_analyses
       (id, visual_asset_id, visual_version_id, analysis_type, provenance_class, payload_json,
        model_id, prompt_version, cost_usd, confidence, review_status, created_at)
       VALUES (?, ?, ?, 'AUTO_SUGGESTION', 'INTERPRETATION', ?, ?, 'visual-v1', 0, ?, 'PENDING', ?)`
    ).bind(analysisId, input.visualAssetId, input.visualVersionId, analysisJson, env.MODEL_VISION, payload.confidence, timestamp),
    env.DB.prepare("UPDATE visual_assets SET visual_kind = ?, storage_state = ?, processing_status = 'READY', pending_storage_state = NULL, last_error = NULL, updated_at = ? WHERE id = ?")
      .bind(payload.visualKind, input.storageState, timestamp, input.visualAssetId),
  ]);

  let embedded = false;
  try {
    const vector = await embedText(env, visualAnalysisText(payload));
    const vectorId = `visual:${input.visualAssetId}:${input.visualVersionId}`;
    await env.VECTOR_INDEX.upsert([{ id: vectorId, values: vector, metadata: { visualAssetId: input.visualAssetId, visualVersionId: input.visualVersionId, visualKind: payload.visualKind } }]);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO visual_embeddings
       (id, visual_asset_id, visual_version_id, basis, model_id, dimensions, vector_id, created_at)
       VALUES (?, ?, ?, 'ANALYSIS_TEXT', ?, ?, ?, ?)`
    ).bind(uuid(), input.visualAssetId, input.visualVersionId, "@cf/baai/bge-m3", vector.length, vectorId, timestamp).run();
    embedded = true;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", scope: "visual-embed", visualAssetId: input.visualAssetId, message: error instanceof Error ? error.message : String(error) }));
  }

  return {
    visualAssetId: input.visualAssetId,
    visualVersionId: input.visualVersionId,
    analysisId,
    model: env.MODEL_VISION,
    costUsd: 0,
    embedded,
    payload,
  };
}

async function runVisualModel(env: Env, input: AnalyzeVisualBytesInput): Promise<VisualAnalysisPayload> {
  const image = `data:${input.mimeType};base64,${base64(input.bytes)}`;
  const invokeModel = () => env.AI.run(env.MODEL_VISION, {
    messages: [
      { role: "system", content: "You are a careful visual research assistant. Output only valid JSON." },
      { role: "user", content: visualAnalysisPrompt({ filename: input.filename, width: input.width, height: input.height, caption: input.caption }) },
    ],
    image,
    max_tokens: 1800,
  } as unknown as Record<string, unknown>);
  const modelCall = input.visionGate ? () => input.visionGate!.execute(invokeModel) : invokeModel;
  const aiResult = input.researchJobId
    ? await withAiCallLedger(
      env.DB,
      {
        researchJobId: input.researchJobId,
        idempotencyKey: `${input.researchJobId}:visual_analysis:${input.visualAssetId}:${input.visualVersionId}:visual-v1`,
        purpose: "visual_analysis",
        model: env.MODEL_VISION,
        reservedUsd: 0.01,
        budgetUsd: Number(env.MONTHLY_BUDGET_USD ?? 10),
      },
      modelCall,
      (result) => responseText(result),
    )
    : await modelCall();
  const payload = validateVisualAnalysis(extractJson(responseText(aiResult)));
  if (!payload) throw new Error("visual_analysis_invalid_output");
  return payload;
}

async function getVisualVersionById(db: D1Database, visualAssetId: string, versionId: string) {
  const row = await db.prepare(
    `SELECT id, visual_asset_id AS visualAssetId, version, variant, r2_key AS r2Key, mime_type AS mimeType,
            width, height, byte_size AS byteSize, content_hash AS contentHash,
            parent_asset_version_id AS parentAssetVersionId, deleted_at AS deletedAt
     FROM visual_asset_versions WHERE id = ? AND visual_asset_id = ? AND deleted_at IS NULL`
  ).bind(versionId, visualAssetId).first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: String(row.id),
    visualAssetId: String(row.visualAssetId),
    version: Number(row.version),
    variant: String(row.variant) as "ORIGINAL" | "CAPSULE" | "SVG_SOURCE",
    r2Key: row.r2Key == null ? null : String(row.r2Key),
    mimeType: String(row.mimeType),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    byteSize: Number(row.byteSize),
    contentHash: String(row.contentHash),
    parentAssetVersionId: row.parentAssetVersionId == null ? null : String(row.parentAssetVersionId),
    deletedAt: row.deletedAt == null ? null : String(row.deletedAt),
  };
}

function parseStoredPayload(raw: string): VisualAnalysisPayload | null {
  try { return validateVisualAnalysis(JSON.parse(raw)); } catch { return null; }
}
