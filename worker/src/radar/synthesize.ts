import type { RadarPeriod } from "@radar/shared";
import { computeStats, windowFor } from "./snapshot";
import { callOpenAi } from "../lib/openai";

export interface SynthesisSection {
  heading: string;
  items: string[];
}

export interface RadarSynthesis {
  period: RadarPeriod;
  narrative: string;
  sections: SynthesisSection[];
  biasWatch: string[];
  costUsd: number;
}

const SECTION_DEFS: Record<RadarPeriod, string[]> = {
  WEEKLY: [
    "rising keywords — what is growing this week",
    "recurring questions",
    "interesting sentences/fragments noticed",
    "new connections between distant materials",
    "unexpected material",
  ],
  MONTHLY: [
    "repeating patterns",
    "movement of interests (what faded, what grew)",
    "research thread candidates",
    "unresolved questions",
    "over-concentrated areas (watch for fixation)",
  ],
  YEARLY: [
    "long-term research trajectory",
    "recurring problematics across the year",
    "new research axes that emerged",
    "weakened interests",
    "next research possibilities",
  ],
};

export async function synthesizeRadar(env: Env, period: RadarPeriod): Promise<RadarSynthesis> {
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

Rules: grounded in given data only; if data is thin, say so honestly in the items. Match the reservoir language (Korean ok). No praise, no filler.`;

  const res = await callOpenAi(env, {
    purpose: `radar-${period.toLowerCase()}`,
    model: "high",
    jsonMode: true,
    maxOutputTokens: 3000,
    messages: [
      { role: "system", content: "You are Radar. Output only valid JSON." },
      { role: "user", content: prompt },
    ],
  });

  const parsed = extractJson(res.text) as { narrative?: string; sections?: SynthesisSection[]; biasWatch?: string[] } | null;
  return {
    period,
    narrative: parsed?.narrative ?? "synthesis unavailable",
    sections: parsed?.sections ?? [],
    biasWatch: parsed?.biasWatch ?? [],
    costUsd: res.costUsd,
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
