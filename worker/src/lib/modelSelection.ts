export interface CuratedModelConfig {
  MODEL_CURATED_IDS_JSON?: string;
  MODEL_HIGH?: string;
  MODEL_DEEP?: string;
}

const EXCLUDED_MODEL_TERMS = ["audio", "embedding", "image", "moderation", "realtime", "search", "sora", "transcrib", "tts", "whisper"];

export function isSelectableModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (!normalized || normalized.startsWith("ft:") || (!normalized.startsWith("gpt-") && !/^o\d/.test(normalized))) return false;
  return !EXCLUDED_MODEL_TERMS.some((term) => normalized.includes(term));
}

export function curatedModelIds(env: CuratedModelConfig): string[] {
  try {
    const parsed = JSON.parse(env.MODEL_CURATED_IDS_JSON ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      const configured = [...new Set(parsed.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(isSelectableModelId))];
      if (configured.length > 0) return configured;
    }
  } catch {
    // Fall back to the active role models when the curated list is not configured.
  }
  return [...new Set([env.MODEL_HIGH, env.MODEL_DEEP].filter((value): value is string => typeof value === "string" && isSelectableModelId(value)))];
}

export function isCuratedModelId(env: CuratedModelConfig, id: string): boolean {
  return curatedModelIds(env).includes(id.trim());
}
