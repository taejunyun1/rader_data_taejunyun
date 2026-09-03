import type { CriticOutput, CounterOutput, DistillOutput } from "./prompts";

export type { CriticOutput, CounterOutput, DistillOutput } from "./prompts";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export function parseDistillOutput(value: unknown): DistillOutput | null {
  if (!record(value)) return null;
  const keys = Object.keys(value).sort();
  const allowed = ["artwork_directions", "keywords", "questions", "read_next", "research_directions", "research_gaps", "small_experiment", "thoughts_fragments"];
  if (!keys.every((k) => allowed.includes(k)) || keys.some((k) => k === "small_experiment" ? false : false)) return null;
  if (!strings(value.keywords) || !strings(value.thoughts_fragments) || !strings(value.questions) || !strings(value.research_directions) || !strings(value.artwork_directions)) return null;
  if (!Array.isArray(value.read_next) || !value.read_next.every((item) => record(item) && exactKeys(item, ["author", "related_question", "title", "why_read"].filter((k) => item[k] !== undefined)) && typeof item.title === "string" && typeof item.why_read === "string" && (item.author === undefined || typeof item.author === "string") && (item.related_question === undefined || typeof item.related_question === "string"))) return null;
  if (!Array.isArray(value.research_gaps) || !value.research_gaps.every((item) => record(item) && exactKeys(item, ["gap", "kind"]) && typeof item.gap === "string" && typeof item.kind === "string")) return null;
  if (value.small_experiment !== undefined && typeof value.small_experiment !== "string") return null;
  return value as unknown as DistillOutput;
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
