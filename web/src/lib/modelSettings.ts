import type { AiModelRoles } from "@radar/shared";

export interface ModelOption {
  id: string;
  created: number;
  shutdownDate: string | null;
  pricingKnown?: boolean;
}

const EXCLUDED_MODEL_TERMS = [
  "audio",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "search",
  "sora",
  "transcrib",
  "tts",
  "whisper",
];

export function isSelectableModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  if (!normalized || normalized.startsWith("ft:") || (!normalized.startsWith("gpt-") && !/^o\d/.test(normalized))) return false;
  return !EXCLUDED_MODEL_TERMS.some((term) => normalized.includes(term));
}

export function filterSelectableModels(models: ModelOption[]): ModelOption[] {
  return models
    .filter((model) => isSelectableModelId(model.id) && (!model.shutdownDate || new Date(model.shutdownDate).getTime() > Date.now()))
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
}

export function parseModelRoles(value: unknown, fallback: AiModelRoles): AiModelRoles {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<AiModelRoles>;
  if (typeof candidate.baseModel !== "string" || typeof candidate.reviewModel !== "string" || !isSelectableModelId(candidate.baseModel) || !isSelectableModelId(candidate.reviewModel)) return fallback;
  return { baseModel: candidate.baseModel, reviewModel: candidate.reviewModel };
}
