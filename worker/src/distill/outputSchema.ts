import type { DistillDetails, DistillOutput } from "@radar/shared";
import type { CriticOutput, CounterOutput } from "./prompts";

export type { CriticOutput, CounterOutput } from "./prompts";
export type { DistillDetails, DistillOutput } from "@radar/shared";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseDistillOutput(value: unknown): DistillOutput | null {
  if (!record(value)) return null;
  const keys = Object.keys(value).sort();
  const allowed = ["artwork_directions", "details", "keywords", "questions", "read_next", "research_directions", "research_gaps", "small_experiment", "thoughts_fragments"];
  if (!keys.every((k) => allowed.includes(k)) || keys.some((k) => k === "small_experiment" ? false : false)) return null;
  if (!strings(value.keywords) || !strings(value.thoughts_fragments) || !strings(value.questions) || !strings(value.research_directions) || !strings(value.artwork_directions)) return null;
  if (!Array.isArray(value.read_next) || !value.read_next.every((item) => record(item) && exactKeys(item, ["author", "related_question", "title", "why_read"].filter((k) => item[k] !== undefined)) && typeof item.title === "string" && typeof item.why_read === "string" && (item.author === undefined || typeof item.author === "string") && (item.related_question === undefined || typeof item.related_question === "string"))) return null;
  if (!Array.isArray(value.research_gaps) || !value.research_gaps.every((item) => record(item) && exactKeys(item, ["gap", "kind"]) && typeof item.gap === "string" && typeof item.kind === "string")) return null;
  if (value.small_experiment !== undefined && typeof value.small_experiment !== "string") return null;
  if (value.details !== undefined && !parseDetails(value.details)) return null;
  return value as unknown as DistillOutput;
}

export function sanitizeDistillDetails(output: DistillOutput, allowedSourceIds: ReadonlySet<string>): DistillOutput {
  if (!output.details) return output;
  const details = {
    thoughts: sanitizeItems(output.details.thoughts, output.thoughts_fragments.length, allowedSourceIds),
    questions: sanitizeItems(output.details.questions, output.questions.length, allowedSourceIds),
    researchGaps: sanitizeItems(output.details.researchGaps, output.research_gaps.length, allowedSourceIds),
    researchDirections: sanitizeItems(output.details.researchDirections, output.research_directions.length, allowedSourceIds),
    artworkDirections: sanitizeItems(output.details.artworkDirections, output.artwork_directions.length, allowedSourceIds),
  };
  const hasDetails = Object.values(details).some((items) => items.length > 0);
  return hasDetails ? { ...output, details } : withoutDetails(output);
}

function withoutDetails(output: DistillOutput): DistillOutput {
  const { details: _details, ...base } = output;
  return base;
}

function sanitizeItems<T extends { summaryIndex: number; sourceIds: string[] }>(items: T[], summaryCount: number, allowedSourceIds: ReadonlySet<string>): T[] {
  const seen = new Set<number>();
  return items.flatMap((item) => {
    if (!Number.isInteger(item.summaryIndex) || item.summaryIndex < 0 || item.summaryIndex >= summaryCount || seen.has(item.summaryIndex)) return [];
    seen.add(item.summaryIndex);
    return [{ ...item, sourceIds: [...new Set(item.sourceIds.filter((id) => allowedSourceIds.has(id)))].slice(0, 3) }];
  });
}

function parseDetails(value: unknown): value is DistillDetails {
  if (!record(value) || !exactKeys(value, ["artworkDirections", "questions", "researchDirections", "researchGaps", "thoughts"])) return false;
  return detailsArray(value.thoughts, ["nextCheck", "rationale", "sourceIds", "summaryIndex", "uncertainty"])
    && detailsArray(value.questions, ["evidenceNeeded", "method", "sourceIds", "summaryIndex", "whyNow"])
    && detailsArray(value.researchGaps, ["diagnosis", "researchMethod", "sourceIds", "summaryIndex"])
    && detailsArray(value.researchDirections, ["expectedOutcome", "method", "rationale", "sourceIds", "summaryIndex"])
    && detailsArray(value.artworkDirections, ["materials", "observation", "procedure", "rationale", "sourceIds", "summaryIndex"]);
}

function detailsArray(value: unknown, keys: string[]): boolean {
  return Array.isArray(value) && value.every((item) => {
    if (!record(item) || !exactKeys(item, keys) || !Number.isInteger(item.summaryIndex) || !Array.isArray(item.sourceIds) || !item.sourceIds.every((id) => typeof id === "string")) return false;
    return keys.filter((key) => !["summaryIndex", "sourceIds", "materials"].includes(key)).every((key) => typeof item[key] === "string")
      && ("materials" in item ? Array.isArray(item.materials) && item.materials.every((material) => typeof material === "string") : true);
  });
}

export function parseCriticOutput(value: unknown): CriticOutput | null {
  if (!record(value) || !exactKeys(value, ["overall", "warnings"]) || typeof value.overall !== "string" || !Array.isArray(value.warnings)) return null;
  if (!value.warnings.every((item) => record(item) && exactKeys(item, ["category", "note"]) && typeof item.category === "string" && typeof item.note === "string")) return null;
  return value as unknown as CriticOutput;
}

export function parseCounterOutput(value: unknown): CounterOutput | null {
  if (!record(value) || !Array.isArray(value.axes) || !Array.isArray(value.suggestions)) return null;
  return value as unknown as CounterOutput;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}
