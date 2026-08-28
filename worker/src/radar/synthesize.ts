import type { RadarPeriod } from "@radar/shared";
import { computeStats, windowFor } from "./snapshot";
import { callOpenAi } from "../lib/openai";
import type { RadarSynthesis, SynthesisSection } from "./types";

export type { RadarSynthesis } from "./types";

const SECTION_DEFS: Record<RadarPeriod, string[]> = {
  WEEKLY: [
    "이번 주 새로 떠오른 키워드",
    "반복해서 남은 질문",
    "눈에 걸린 문장과 단편",
    "멀리 있는 자료 사이의 새 연결",
    "예상 밖의 자료",
  ],
  MONTHLY: [
    "반복되는 패턴",
    "관심의 이동",
    "연구 흐름 후보",
    "아직 풀리지 않은 질문",
    "집중이 과한 영역",
  ],
  YEARLY: [
    "장기 연구 궤적",
    "올해 반복된 문제의식",
    "새로 생긴 연구 축",
    "약해진 관심",
    "다음 연구 가능성",
  ],
};

export async function synthesizeRadar(env: Env, period: RadarPeriod, researchJobId?: string): Promise<RadarSynthesis> {
  const { start, end } = windowFor(period, new Date());
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  const stats = await computeStats(env.DB, startIso, endIso);

  const recentDistills = await env.DB.prepare(
    `SELECT output_json FROM distill_sessions WHERE created_at >= ? ORDER BY created_at DESC LIMIT 3`
  )
    .bind(startIso)
    .all<{ output_json: string }>();

  const distillSummaries = (recentDistills.results ?? [])
    .map((r) => {
      try {
        const o = JSON.parse(r.output_json) as { keywords?: string[]; questions?: string[]; thoughts_fragments?: string[] };
        return `keywords: ${o.keywords?.join(", ") ?? "-"}\nquestions: ${(o.questions ?? []).slice(0, 2).join(" / ")}\nthought: ${(o.thoughts_fragments ?? []).slice(0, 2).join(" / ")}`;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .join("\n---\n");

  const keywordsAllTime = await env.DB.prepare(
    `SELECT keyword, COUNT(*) AS n FROM keywords GROUP BY keyword ORDER BY n DESC LIMIT 20`
  ).all<{ keyword: string; n: number }>();

  const prompt = `You are Radar, the periodic synthesis layer of Research Radar — a research companion for a photographer-researcher (photography, image theory, machine vision, media art). You read signal statistics and produce the ${period} research radar report.

PERIOD: ${startIso.slice(0, 10)} to ${endIso.slice(0, 10)}

SIGNAL STATS (pure SQL aggregates, provenance = SOURCE):
- new sources: ${stats.newSources}
- new keywords (freq): ${stats.newKeywords.map((k) => `${k.keyword}(${k.count})`).join(", ") || "none"}
- new questions: ${stats.newQuestions.join(" / ") || "none"}
- user signals: ${JSON.stringify(stats.signalCounts)}
- top kept/developed: ${stats.topKeptSources.map((s) => s.title).join(" | ") || "none"}
- distill runs: ${stats.distillRuns}, gaps raised: ${stats.gapsRaised}, reading queue: ${stats.readingQueueSize}
- reservoir composition: ${JSON.stringify(stats.kindBreakdown)}

KEYWORDS ALL-TIME (for bias detection — compare with recent to spot fixation):
${keywordsAllTime.results?.map((k) => `${k.keyword}(${k.n})`).join(", ") || "none"}

RECENT DISTILL OUTPUTS (provenance = SYNTHESIS by Distill):
${distillSummaries || "none"}

Produce the report as strict JSON:
{
  "narrative": "2-4 sentences: where the research is heading this ${period.toLowerCase()}, in plain language",
  "sections": [
    {"heading": "<one of the section definitions below>", "items": ["1-3 short concrete items each, grounded in the stats — no invention"]}
  ],
  "biasWatch": ["if any keyword/aesthetic is over-repeating across all-time vs recent, name it and suggest what the Counter layer should push against; empty array if healthy"]
}

SECTIONS REQUIRED (exactly these headings):
${SECTION_DEFS[period].map((s) => `- ${s}`).join("\n")}

Rules: grounded in given data only; if data is thin, say so honestly in the items. Write every heading and explanatory sentence in Korean. Keep proper nouns, source titles, names, and technical keywords in original language when they are source content. Use the exact Korean section headings above. No praise, no filler.`;

  const res = await callOpenAi(env, {
    purpose: `radar-${period.toLowerCase()}`,
    researchJobId,
    workflowStep: `radar-${period.toLowerCase()}`,
    promptVersion: "radar-v1",
    model: "deep",
    jsonMode: true,
    maxOutputTokens: 3000,
    messages: [
      { role: "system", content: "You are Radar. Output only valid JSON." },
      { role: "user", content: prompt },
    ],
  });

  return normalizeSynthesis(extractJson(res.text), period, res.costUsd);
}

const OBJECT_LABELS: Record<string, string> = {
  observation: "관찰",
  recommendation: "추천",
  reason: "이유",
  evidence: "근거",
  direction: "방향",
  note: "메모",
  question: "질문",
  summary: "요약",
  text: "내용",
  overRepeating: "반복되는 영역",
};

function localizeRadarText(value: string): string {
  return value
    .replace(/\bDistill\b/g, "착즙")
    .replace(/\bdistill\b/g, "착즙")
    .replace(/\bReservoir\b/g, "저장소")
    .replace(/\breservoir\b/g, "저장소")
    .replace(/\bCounter layer\b/gi, "반대 관점 계층");
}

function toText(value: unknown): string | null {
  if (typeof value === "string") return localizeRadarText(value.trim()) || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map(toText).filter((item): item is string => Boolean(item));
    return items.length ? items.join(" · ") : null;
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const text = toText(item);
      return text ? `${OBJECT_LABELS[key] ?? key}: ${text}` : null;
    })
    .filter((item): item is string => Boolean(item));
  return entries.length ? entries.join(" · ") : null;
}

function normalizeSynthesis(raw: unknown, period: RadarPeriod, costUsd: number): RadarSynthesis {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections.map((section) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) return null;
      const item = section as Record<string, unknown>;
      const items = (Array.isArray(item.items) ? item.items : [item.items])
        .map(toText)
        .filter((value): value is string => Boolean(value));
      return { heading: toText(item.heading) ?? "연구 흐름", items };
    }).filter((section): section is SynthesisSection => Boolean(section))
    : [];
  return {
    period,
    narrative: toText(parsed.narrative) ?? "생성된 서사 내용이 없습니다.",
    sections,
    biasWatch: Array.isArray(parsed.biasWatch) ? parsed.biasWatch.map(toText).filter((value): value is string => Boolean(value)) : [],
    costUsd,
  };
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}
