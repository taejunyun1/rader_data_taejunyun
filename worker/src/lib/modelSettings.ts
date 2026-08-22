import type { AiModelRoles } from "@radar/shared";
import { curatedModelIds, isCuratedModelId, isSelectableModelId, type CuratedModelConfig } from "./modelSelection";

export { curatedModelIds, isCuratedModelId, isSelectableModelId } from "./modelSelection";

export const MODEL_ROLES_KEY = "ai_model_roles_v1";

export interface AvailableModel {
  id: string;
  created: number;
  shutdownDate: string | null;
  pricingKnown: boolean;
}

interface OpenAiModelResponse {
  data?: { id?: unknown; created?: unknown; shutdown_date?: unknown }[];
}

interface ModelPricing {
  input: number;
  output: number;
}

export function parseSavedModelRoles(value: unknown, fallback: AiModelRoles, env: CuratedModelConfig): AiModelRoles {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<AiModelRoles>;
  if (typeof candidate.baseModel !== "string" || typeof candidate.reviewModel !== "string") return fallback;
  if (!isCuratedModelId(env, candidate.baseModel) || !isCuratedModelId(env, candidate.reviewModel)) return fallback;
  return { baseModel: candidate.baseModel, reviewModel: candidate.reviewModel };
}

export function fallbackModelRoles(env: Env): AiModelRoles {
  return { baseModel: env.MODEL_HIGH, reviewModel: env.MODEL_DEEP || env.MODEL_HIGH };
}

export async function loadModelRoles(db: D1Database, env: Env): Promise<AiModelRoles> {
  const fallback = fallbackModelRoles(env);
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(MODEL_ROLES_KEY).first<{ value: string }>();
  if (!row) return fallback;
  try {
    return parseSavedModelRoles(JSON.parse(row.value), fallback, env);
  } catch {
    return fallback;
  }
}

export async function saveModelRoles(db: D1Database, roles: AiModelRoles): Promise<void> {
  await db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(MODEL_ROLES_KEY, JSON.stringify(roles), new Date().toISOString())
    .run();
}

export async function listAvailableModels(env: Env): Promise<AvailableModel[]> {
  const response = await fetch(`${env.OPENAI_BASE_URL}/models`, { headers: openAiHeaders(env) });
  if (!response.ok) throw new Error(`model_list_error_${response.status}`);
  const data = (await response.json()) as OpenAiModelResponse;
  const now = Date.now();
  return (data.data ?? [])
    .flatMap((item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const created = typeof item.created === "number" ? item.created : 0;
      const shutdownDate = typeof item.shutdown_date === "string" ? item.shutdown_date : null;
      if (!isCuratedModelId(env, id) || (shutdownDate && new Date(shutdownDate).getTime() <= now)) return [];
      return [{ id, created, shutdownDate, pricingKnown: Boolean(modelPricing(env)[id]) }];
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

export function modelPricing(env: Env): Record<string, ModelPricing> {
  try {
    const parsed = JSON.parse(env.MODEL_PRICING_JSON ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, value]) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<ModelPricing>;
      return typeof candidate.input === "number" && candidate.input >= 0 && typeof candidate.output === "number" && candidate.output >= 0
        ? [[id, { input: candidate.input, output: candidate.output }]]
        : [];
    }));
  } catch {
    return {};
  }
}

export function pricingForModel(env: Env, model: string): { input: number; output: number; known: boolean } {
  const known = modelPricing(env)[model];
  if (known) return { ...known, known: true };
  return {
    input: Number(env.MODEL_UNKNOWN_INPUT_USD ?? "5"),
    output: Number(env.MODEL_UNKNOWN_OUTPUT_USD ?? "30"),
    known: false,
  };
}

export function openAiHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.CF_AIG_TOKEN) headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  return headers;
}
