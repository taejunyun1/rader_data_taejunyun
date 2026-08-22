import type { DistillContext } from "./context";

export type PromptVariant = "distill-v1" | "distill-v2-terse";
export const DEFAULT_PROMPT_VARIANT: PromptVariant = "distill-v2-terse";
export const PROMPT_VARIANTS: PromptVariant[] = ["distill-v1", "distill-v2-terse"];

export interface DistillOutput {
  keywords: string[];
  thoughts_fragments: string[];
  questions: string[];
  read_next: { title: string; author?: string; why_read: string; related_question?: string }[];
  research_gaps: { gap: string; kind: string }[];
  research_directions: string[];
  artwork_directions: string[];
  small_experiment?: string;
}

export interface CriticOutput {
  warnings: { category: string; note: string }[];
  overall: string;
}

export interface CounterOutput {
  dominant_claim?: string;
  opposing_thesis?: string;
  incompatibility?: string;
  conditions?: string[];
  axes: { from: string; to: string; rationale: string }[];
  suggestions: {
    direction: string;
    grounding: { name: string; kind: string; note: string }[];
  }[];
  validation?: {
    status: "verified" | "corrected" | "unverified";
    issues: string[];
    scores?: { directOpposition: number; internalConsistency: number; sourceTraceability: number; groundingIntegrity: number; nonStrawman: number };
  };
}

function paramLine(p: DistillContext["params"]): string {
  return [
    `familiarity=${p.familiarity.toFixed(2)} (0=favor existing interests, 1=favor new territory)`,
    `research_depth=${p.researchDepth.toFixed(2)} (0=light exploration, 1=deep research)`,
    `divergence=${p.divergence.toFixed(2)} (0=coherent connections, 1=unexpected connections)`,
    `technical_photographic=${p.technicalPhotographic.toFixed(2)} (0=systems/tech, 1=photography/light/print/matter)`,
  ].join("\n");
}

export function distillPrompt(ctx: DistillContext, variant: PromptVariant = "distill-v1"): string {
  const terse = variant === "distill-v2-terse";
  const sources = ctx.sources
    .map((s) => {
      const bits = [
        `[${s.kind}${s.year ? ` ${s.year}` : ""}${s.signals.length ? `; signals: ${s.signals.join("/")}` : ""}${s.resurfaced ? "; RESURFACED (older material relevant again — connect it to current momentum)" : ""}] ${s.title}`,
      ];
      if (s.summary) bits.push(`  summary: ${s.summary}`);
      for (const f of s.fragments) bits.push(`  fragment: "${f}"`);
      return bits.join("\n");
    })
    .join("\n");

  return `You are Distill, the core editorial engine of Research Radar — a research companion for a photographer-researcher (photography, image theory, machine vision, computational photography, media art). You compress a research reservoir into a focused edition. You are NOT a chatbot: output the structured edition only.

USER PARAMETERS (let these shape proportion and tone):
${paramLine(ctx.params)}

CURRENT MOMENTUM KEYWORDS (frequency in reservoir, recent 60d):
${ctx.keywords.map((k) => `${k.keyword} (${k.count})`).join(", ") || "(none yet)"}

OPEN QUESTIONS FROM THE RESERVOIR:
${ctx.questions.map((q) => `- ${q}`).join("\n") || "(none yet)"}

RECENTLY KEPT / DEVELOPED BY THE USER (highest interest):
${ctx.recentKeepDevelop.map((t) => `- ${t}`).join("\n") || "(none yet)"}

SOURCE MATERIAL (summaries + verbatim fragments; provenance = SOURCE):
${sources || "(reservoir nearly empty — say so in overall tone, work with keywords/questions)"}

Produce the weekly edition as strict JSON:
{
  "keywords": ["5-7 keywords that best capture the CURRENT research momentum (may differ from reservoir keywords)"],
  "thoughts_fragments": ["3-5 compressed thoughts: connections, tensions, observations. These are SYNTHESIS (your interpretation), never presented as source quotes"],
  "questions": ["about 3 research questions worth pursuing now"],
  "read_next": [
    {"title": "real paper/article/text title", "author": "real author if known with confidence", "why_read": "1-2 sentences: what this would answer", "related_question": "which of the questions above it serves"}
  ],
  "research_gaps": [{"gap": "what is unclear/unargued/disconnected", "kind": "one of: under-evidenced|missing-source|conflicting-claims|needs-firsthand-research|artistically-possible-academically-untested"}],
  "research_directions": ["about 2 possible research directions"],
  "artwork_directions": ["about 2 possible artwork directions, concrete and material"],
  "small_experiment": "optional: one small, doable experiment (skip if nothing genuinely useful)"
}

HARD RULES:
- read_next: ONLY works you are confident actually exist (widely known papers, books, essays). NO invented titles. If unsure of a title, omit the entry. 3-5 entries. Prefer items connected to the user's photographic/image-theory focus.
- Never fabricate quotes. Distinguish source fragments (quoted above) from your synthesis.
- Respect the user's parameters: high divergence → allow more unexpected links; low familiarity → stay closer to existing keywords.
- The photographer's own works (PERSONAL_WORK) are the center of gravity: connect outward from them, do not ignore them.
- Language: write ALL prose in Korean (thoughts, questions, gaps, directions, experiment, why_read). Keep proper nouns verbatim in original language: book/paper titles, author names, artist names, technical terms (e.g. "Towards a Philosophy of Photography — Vilém Flusser", "NeRF", "wet plate"). Keyword terms may stay in original language when they are established technical terms, but add Korean gloss where natural (e.g. "인덱스 index").${
    terse
      ? `

TERSE MODE (v2 variant):
- thoughts_fragments: each ≤ 2 sentences, no preamble — one dense claim per line.
- questions: sharply specific (a nameable method could answer each).
- research/artwork_directions: ≤ 1 sentence each, must contain a concrete material or method.
- Cut all hedging words ("might", "could be seen as"). Prefer nouns and verbs over abstraction.`
      : ""
  }`;
}

export function criticPrompt(distillJson: string): string {
  return `You are Critic, the verification layer of Research Radar. You review a Distill edition for logic, evidence, and language problems. You run automatically on every Distill. Be brief — only warnings that matter.

Check for these categories (only flag what actually occurs):
- insufficient_evidence (claims without reservoir support)
- logical_leap (conceptual jumps)
- overgeneralization
- technical_error (wrong technical claims about photography/computation)
- terminology_confusion
- source_mismatch (claim attributed to a source that does not support it)
- cliched_language (tired media-art rhetoric: "between presence and absence", "boundary of real and virtual" etc. — flag only if pervasive)
- excessive_similarity (too close to existing well-known research/practice without acknowledgment)

ALSO distinguish: academic_insufficiency (would not survive scholarly review) vs artistic_viability (still valid as artistic proposition). If a gap is artistically viable but academically weak, say so instead of just rejecting.

THE DISTILL EDITION TO REVIEW:
${distillJson}

Return strict JSON:
{
  "warnings": [{"category": "one of the categories above", "note": "one short sentence pointing at the specific item"}],
  "overall": "one sentence: sound / sound-with-cautions / needs-revision, and why"
}

Keep warnings to what a careful reader would actually flag. No praise. Write warnings and overall in Korean (proper nouns stay in original language).`;
}

export function counterPrompt(distillJson: string, counterStrength: number, sourceEvidence = "(source evidence unavailable)", repairFeedback = ""): string {
  return `You are Counter, the anti-confirmation-bias layer of Research Radar for a photographer-researcher. You dynamically construct the OPPOSITE pole of the current Distill edition's keywords and aesthetic orientation.

Counter strength parameter = ${counterStrength.toFixed(2)}. This controls how radical and unfamiliar the practical reversal is; it must not weaken the requirement for a genuine opposite thesis.

METHOD (dynamic, not a fixed lookup):
1. State the edition's strongest claim or aesthetic tendency as 'dominant_claim'.
2. Construct one 'opposing_thesis' that cannot be true at the same time as that claim. A weaker version, supplement, compromise, or topic change is not an opposition.
3. Explain the exact incompatibility and the conditions under which the opposing thesis becomes more persuasive.
4. Ground each counter-direction in real photographic/artistic practice: actual photographers, artists, working methods, media, or texts you are confident exist. NO invented names or works.

THE DISTILL EDITION:
${distillJson}

SOURCE EVIDENCE AVAILABLE TO THIS EDITION:
${sourceEvidence}

${repairFeedback ? `A previous draft failed verification. Repair it using these issues while keeping the opposition explicit:\n${repairFeedback}` : ""}

Return strict JSON:
{
  "dominant_claim": "the strongest claim or aesthetic tendency in the edition",
  "opposing_thesis": "a direct thesis that cannot coexist with the dominant claim",
  "incompatibility": "why the two positions cannot both be the governing principle",
  "conditions": ["conditions that make the opposing thesis more persuasive"],
  "axes": [{"from": "dominant tendency in the edition", "to": "its opposite pole", "rationale": "one sentence why this counters confirmation bias now"}],
  "suggestions": [
    {
      "direction": "a concrete counter-direction for the artist (1-2 sentences)",
      "grounding": [{"name": "real artist/photographer/work/text", "kind": "artist|work|text|method", "note": "one sentence of relevance"}]
    }
  ]
}

Rules: 2-4 axes. 1-2 suggestions only (the strongest). Every grounding item must be real. Write in Korean; keep artist/work/method names in original language.`;
}

export function counterValidationPrompt(distillJson: string, counterJson: string, sourceEvidence: string): string {
  return `You are the verification layer for a research Counter proposal. Decide whether the Counter is a genuine, coherent opposite of the Distill edition, not a mild supplement or a strawman.

DISTILL:
${distillJson}

COUNTER:
${counterJson}

SOURCE EVIDENCE:
${sourceEvidence}

Return strict JSON:
{
  "status": "verified" | "unverified",
  "issues": ["specific issue, empty when sound"],
  "scores": {"directOpposition": 0, "internalConsistency": 0, "sourceTraceability": 0, "groundingIntegrity": 0, "nonStrawman": 0}
}

Score each item 0-1. 'status' is verified only when every score is at least 0.75 and the opposing thesis truly cannot govern at the same time as the dominant claim. Do not reward a generic alternative or a more extreme version of the same idea. Keep the response in Korean.`;
}

export function extractJsonLoose(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through to repair */
    }
  }
  return repairTruncatedJson(text.slice(start >= 0 ? start : 0));
}

function repairTruncatedJson(fragment: string): unknown {
  const strings: string[] = [];
  const masked = fragment.replace(/"(?:[^"\\]|\\.)*"/g, (s) => {
    strings.push(s);
    return `"__S${strings.length - 1}__"`;
  });

  for (let cut = masked.length; cut > 0; cut--) {
    const candidate = masked.slice(0, cut);
    const opens = (candidate.match(/\{/g) ?? []).length - (candidate.match(/\}/g) ?? []).length;
    const opensArr = (candidate.match(/\[/g) ?? []).length - (candidate.match(/\]/g) ?? []).length;
    if (opens < 0 || opensArr < 0) return null;
    let repaired = candidate;
    if (opensArr > 0) repaired += "]".repeat(opensArr);
    if (opens > 0) repaired += "}".repeat(opens);
    const lastComma = repaired.search(/,\s*(["\}\]])?\s*$/);
    if (lastComma >= 0 && !/["\}\]]\s*$/.test(repaired.replace(/,\s*$/, ""))) repaired = repaired.replace(/,\s*$/, "");
    try {
      const parsed = JSON.parse(repaired) as unknown;
      return JSON.parse(
        JSON.stringify(parsed).replace(/"__S(\d+)__"/g, (_, i) => JSON.stringify(strings[Number(i)]).slice(1, -1))
      );
    } catch {
      continue;
    }
  }
  return null;
}
