import { labelOf, SOURCE_KIND_LABELS } from "./labels";

export interface KeywordCount {
  keyword: string;
  count: number;
}

export interface RadarStats {
  newSources: number;
  newKeywords: KeywordCount[];
  newQuestions: string[];
  signalCounts: Record<string, number>;
  topKeptSources: { title: string; kind: string }[];
  distillRuns: number;
  gapsRaised: number;
  readingQueueSize: number;
  kindBreakdown: Record<string, number>;
}

export interface SynthesisSection {
  heading: string;
  items: string[];
}

export interface DecisionRow {
  action: "develop" | "keep" | "watch" | "ignore";
  label: string;
  count: number;
  percent: number;
}

export interface CompositionRow {
  kind: string;
  label: string;
  count: number;
  percent: number;
}

const DECISIONS = [
  { action: "develop", label: "발전" },
  { action: "keep", label: "보관" },
  { action: "watch", label: "관찰" },
  { action: "ignore", label: "제외" },
] as const;

const DUPLICATE_SYNTHESIS_HEADINGS = new Set([
  "이번 주 새로 떠오른 키워드",
  "반복해서 남은 질문",
  "아직 풀리지 않은 질문",
  "집중이 과한 영역",
]);

export function decisionRows(signalCounts: Record<string, number>): DecisionRow[] {
  const total = DECISIONS.reduce((sum, item) => sum + (signalCounts[item.action] ?? 0), 0);
  return DECISIONS.map((item) => {
    const count = signalCounts[item.action] ?? 0;
    return { ...item, count, percent: total ? Math.round((count / total) * 100) : 0 };
  });
}

export function compositionRows(kindBreakdown: Record<string, number>, limit = 6): CompositionRow[] {
  const entries = Object.entries(kindBreakdown).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const visible = entries.slice(0, Math.max(limit - 1, 0));
  const overflow = entries.slice(Math.max(limit - 1, 0)).reduce((sum, [, count]) => sum + count, 0);
  const grouped = overflow > 0 ? [...visible, ["OTHER", overflow] as const] : entries.slice(0, limit);
  return grouped.map(([kind, count]) => ({
    kind,
    label: kind === "OTHER" ? "기타" : labelOf(SOURCE_KIND_LABELS, kind),
    count,
    percent: total ? Math.round((count / total) * 100) : 0,
  }));
}

export function visibleSynthesisSections(sections: SynthesisSection[]): SynthesisSection[] {
  return sections.filter((section) => !DUPLICATE_SYNTHESIS_HEADINGS.has(section.heading));
}
