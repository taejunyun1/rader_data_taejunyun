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
  visualKind: "PHOTO" | "ARTWORK" | "INSTALLATION" | "GRAPHIC" | "DIAGRAM" | "DOCUMENT_SCAN" | "OTHER";
  confidence: number | null;
}

const ARRAY_LIMITS: Record<string, number> = {
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
};

function strings(value: unknown, key: string, maxLength = 320): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, maxLength))
    .slice(0, ARRAY_LIMITS[key] ?? 8);
}

function group(value: unknown, keys: string[]): Record<string, string[]> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(keys.map((key) => [key, strings(source[key], key)]));
}

export function validateVisualAnalysis(raw: unknown): VisualAnalysisPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const root = ((raw as { analysis?: unknown }).analysis ?? raw) as Record<string, unknown>;
  if (!root || typeof root !== "object") return null;
  const visualKinds = new Set(["PHOTO", "ARTWORK", "INSTALLATION", "GRAPHIC", "DIAGRAM", "DOCUMENT_SCAN", "OTHER"]);
  const confidence = typeof root.confidence === "number" && Number.isFinite(root.confidence)
    ? Math.min(Math.max(root.confidence, 0), 1)
    : null;
  const payload: VisualAnalysisPayload = {
    observation: group(root.observation, ["subject", "composition", "color", "texture", "spatialRelation", "material", "lighting", "visibleText"]) as VisualAnalysisPayload["observation"],
    formal: group(root.formal, ["shapes", "lines", "planes", "rhythm", "scale", "density", "edges", "contrast", "perspective"]) as VisualAnalysisPayload["formal"],
    context: group(root.context, ["medium", "process", "relationToPhotography", "culturalReferences"]) as VisualAnalysisPayload["context"],
    propositions: strings(root.propositions, "propositions", 500),
    uncertainty: strings(root.uncertainty, "uncertainty", 320),
    visualKind: typeof root.visualKind === "string" && visualKinds.has(root.visualKind) ? root.visualKind as VisualAnalysisPayload["visualKind"] : "OTHER",
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

export function visualAnalysisPrompt(metadata: { filename?: string; width: number | null; height: number | null; caption: string | null }): string {
  return `You are the visual reading layer of Research Radar for a photographer-researcher.

Read the image as material for research, not as a generic caption. Separate what is visibly supported from interpretation. Do not identify a person, artwork, author, location, or cultural reference unless the image itself provides evidence; put uncertain guesses in uncertainty.

Return strict JSON with this shape:
{
  "visualKind": "PHOTO|ARTWORK|INSTALLATION|GRAPHIC|DIAGRAM|DOCUMENT_SCAN|OTHER",
  "confidence": 0.0,
  "observation": {"subject": [], "composition": [], "color": [], "texture": [], "spatialRelation": [], "material": [], "lighting": [], "visibleText": []},
  "formal": {"shapes": [], "lines": [], "planes": [], "rhythm": [], "scale": [], "density": [], "edges": [], "contrast": [], "perspective": []},
  "context": {"medium": [], "process": [], "relationToPhotography": [], "culturalReferences": []},
  "propositions": [],
  "uncertainty": []
}

Writing rules:
- Keep each item concrete and short (one sentence or phrase).
- Write explanatory strings in Korean; preserve legible text and proper nouns in their original form.
- observation = only directly visible features.
- formal = compositional/formal vocabulary grounded in the image.
- context = plausible research context; mark uncertain attribution or reference explicitly.
- propositions = possible questions, experiments, or next visual actions, not factual claims.
- Do not invent text that cannot be read. Use an empty visibleText array when no text is legible.

File metadata: ${metadata.filename ?? "unknown"}; ${metadata.width ?? "?"}×${metadata.height ?? "?"}; caption: ${metadata.caption ?? "none"}`;
}

export function visualAnalysisText(payload: VisualAnalysisPayload): string {
  const flatten = (group: Record<string, string[]>) => Object.entries(group)
    .flatMap(([key, values]) => values.map((value) => `${key}: ${value}`));
  return [
    `visualKind: ${payload.visualKind}`,
    ...flatten(payload.observation),
    ...flatten(payload.formal),
    ...flatten(payload.context),
    ...payload.propositions.map((value) => `proposition: ${value}`),
    ...payload.uncertainty.map((value) => `uncertainty: ${value}`),
  ].join("\n");
}
