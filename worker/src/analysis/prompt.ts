export interface SourceAnalysisPayload {
  classification?: {
    suggestedKind?: string;
    reliability?: string;
    language?: string;
    medium?: string;
  };
  summary?: string;
  keywords?: string[];
  important_fragments?: string[];
  questions?: string[];
  people?: string[];
  artists?: string[];
  technologies?: string[];
  works?: string[];
  concepts?: string[];
  dates?: string[];
  connections?: string[];
  contradictions?: string[];
}

type AnalysisKey = keyof SourceAnalysisPayload;

const ARRAY_KEYS: AnalysisKey[] = [
  "keywords",
  "important_fragments",
  "questions",
  "people",
  "artists",
  "technologies",
  "works",
  "concepts",
  "dates",
  "connections",
  "contradictions",
];

export interface AnalysisModelOutput {
  analysis?: SourceAnalysisPayload;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function analysisPrompt(text: string, kind: string): string {
  return `You are the analysis layer of Research Radar, a personal research system for a photographer-researcher (photography, image theory, machine vision, media art).

Source type (auto-detected at ingest): ${kind}

Analyze the SOURCE text below. Extract ONLY fields that genuinely fit this material — skip any field that does not apply. Never force uniform fields.

Return strict JSON:
{
  "analysis": {
    "classification": { "suggestedKind": "one of PERSONAL_WORK|PERSONAL_TEXT|PAPER_ACADEMIC|BOOK_ARTICLE|ARTIST_ARTWORK|TECHNICAL|WEB|NOTE|DISCOVERY", "reliability": "PRIMARY|SECONDARY|DISCOVERY", "language": "ko|en|mixed", "medium": "short freeform e.g. photography, video, installation, text, software" },
    "summary": "2-4 sentences, plain language",
    "keywords": ["5-10 specific terms, keep original language"],
    "important_fragments": ["1-5 short verbatim quotes that carry the core idea"],
    "questions": ["1-4 research questions this material raises or answers"],
    "people": [], "artists": [], "technologies": [], "works": [], "concepts": [], "dates": [],
    "connections": ["possible links to photography/image/media-art topics, only if evident"],
    "contradictions": ["only if the text contains real tensions"]
  }
}

Rules:
- Quotes must be verbatim from the text (<= 200 chars each).
- Keywords in the source's own language (Korean stays Korean).
- questions = research-relevant questions, not quiz questions.
- Empty arrays are valid; omit nothing from JSON structure but keep arrays empty when not applicable.

SOURCE TEXT:
"""
${text.slice(0, 24_000)}
"""`;
}

export function validateAnalysis(raw: unknown): SourceAnalysisPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const root = (raw as { analysis?: unknown }).analysis ?? raw;
  if (typeof root !== "object") return null;
  const out: SourceAnalysisPayload = {};
  const r = root as Record<string, unknown>;

  const cls = r.classification;
  if (cls && typeof cls === "object") {
    out.classification = {
      suggestedKind: typeof (cls as Record<string, unknown>).suggestedKind === "string" ? String((cls as Record<string, unknown>).suggestedKind) : undefined,
      reliability: typeof (cls as Record<string, unknown>).reliability === "string" ? String((cls as Record<string, unknown>).reliability) : undefined,
      language: typeof (cls as Record<string, unknown>).language === "string" ? String((cls as Record<string, unknown>).language) : undefined,
      medium: typeof (cls as Record<string, unknown>).medium === "string" ? String((cls as Record<string, unknown>).medium) : undefined,
    };
  }
  if (typeof r.summary === "string" && r.summary.trim()) out.summary = r.summary.trim().slice(0, 2000);

  for (const key of ARRAY_KEYS) {
    const v = r[key];
    if (Array.isArray(v)) {
      const cleaned = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 400));
      if (cleaned.length) (out[key] as string[]) = key === "keywords" ? cleaned.slice(0, 12) : cleaned.slice(0, 6);
    }
  }
  return Object.keys(out).length ? out : null;
}
