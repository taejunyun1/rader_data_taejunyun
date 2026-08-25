import { validateVisualAnalysis, type VisualAnalysisPayload } from "@radar/shared";

export { validateVisualAnalysis, type VisualAnalysisPayload };

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
