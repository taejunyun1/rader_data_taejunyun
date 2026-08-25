import type { VisualKind } from "./visual";

export interface VisualAnalysisPayload {
  observation: {
    subject: string[];
    composition: string[];
    color: string[];
    texture: string[];
    spatialRelation: string[];
    material: string[];
    lighting: string[];
    visibleText: string[];
  };
  formal: {
    shapes: string[];
    lines: string[];
    planes: string[];
    rhythm: string[];
    scale: string[];
    density: string[];
    edges: string[];
    contrast: string[];
    perspective: string[];
  };
  context: {
    medium: string[];
    process: string[];
    relationToPhotography: string[];
    culturalReferences: string[];
  };
  propositions: string[];
  uncertainty: string[];
  visualKind: VisualKind;
  confidence: number | null;
}

export const VISUAL_ANALYSIS_ARRAY_LIMITS = {
  subject: 8,
  composition: 8,
  color: 8,
  texture: 8,
  spatialRelation: 8,
  material: 8,
  lighting: 8,
  visibleText: 8,
  shapes: 8,
  lines: 8,
  planes: 8,
  rhythm: 8,
  scale: 8,
  density: 8,
  edges: 8,
  contrast: 8,
  perspective: 8,
  medium: 6,
  process: 6,
  relationToPhotography: 6,
  culturalReferences: 6,
  propositions: 8,
  uncertainty: 8,
} as const;

const VISUAL_KINDS = new Set<VisualKind>([
  "PHOTO",
  "ARTWORK",
  "INSTALLATION",
  "GRAPHIC",
  "DIAGRAM",
  "DOCUMENT_SCAN",
  "OTHER",
]);

const OBSERVATION_KEYS = ["subject", "composition", "color", "texture", "spatialRelation", "material", "lighting", "visibleText"] as const;
const FORMAL_KEYS = ["shapes", "lines", "planes", "rhythm", "scale", "density", "edges", "contrast", "perspective"] as const;
const CONTEXT_KEYS = ["medium", "process", "relationToPhotography", "culturalReferences"] as const;

function arrayLimit(key: string): number {
  return key in VISUAL_ANALYSIS_ARRAY_LIMITS
    ? VISUAL_ANALYSIS_ARRAY_LIMITS[key as keyof typeof VISUAL_ANALYSIS_ARRAY_LIMITS]
    : 8;
}

function strings(value: unknown, key: string, maxLength = 320): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, arrayLimit(key));
}

function group(value: unknown, keys: readonly string[]): Record<string, string[]> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.map((key) => [key, strings(source[key], key)]));
}

/** Shared, side-effect-free visual analysis contract used by Worker and web editor. */
export function validateVisualAnalysis(raw: unknown): VisualAnalysisPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const root = ((raw as { analysis?: unknown }).analysis ?? raw) as Record<string, unknown>;
  if (!root || typeof root !== "object") return null;

  const confidence = typeof root.confidence === "number" && Number.isFinite(root.confidence)
    ? Math.min(Math.max(root.confidence, 0), 1)
    : null;
  const payload: VisualAnalysisPayload = {
    observation: group(root.observation, OBSERVATION_KEYS) as VisualAnalysisPayload["observation"],
    formal: group(root.formal, FORMAL_KEYS) as VisualAnalysisPayload["formal"],
    context: group(root.context, CONTEXT_KEYS) as VisualAnalysisPayload["context"],
    propositions: strings(root.propositions, "propositions", 500),
    uncertainty: strings(root.uncertainty, "uncertainty", 320),
    visualKind: typeof root.visualKind === "string" && VISUAL_KINDS.has(root.visualKind as VisualKind)
      ? root.visualKind as VisualKind
      : "OTHER",
    confidence,
  };

  const meaningful = [
    ...Object.values(payload.observation),
    ...Object.values(payload.formal),
    ...Object.values(payload.context),
    payload.propositions,
    payload.uncertainty,
  ].some((values) => values.length > 0);
  return meaningful ? payload : null;
}
