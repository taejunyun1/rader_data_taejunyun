import type { RadarParams } from "@radar/shared";
import { uuid } from "../ingestion/ids";
import { callOpenAi, monthSpendUsd } from "../lib/openai";
import { verifyWork } from "../lib/openalex";
import { buildDistillContext, type DistillContext } from "./context";
import {
  counterPrompt,
  criticPrompt,
  DEFAULT_PROMPT_VARIANT,
  distillPrompt,
  extractJsonLoose,
  type CounterOutput,
  type CriticOutput,
  type DistillOutput,
  type PromptVariant,
} from "./prompts";

export type DistillRunResult =
  | { ok: true; sessionId: string; costUsd: number; budgetUsedPct: number; queueItemIds: string[]; distillOutput: DistillOutput }
  | { ok: false; error: string; budgetUsedPct: number };

function asValidated<T>(raw: unknown, kind: "distill"): DistillOutput | null;
function asValidated(raw: unknown, kind: "critic"): CriticOutput | null;
function asValidated(raw: unknown, kind: "counter"): CounterOutput | null;
function asValidated(raw: unknown, kind: string): unknown {
  if (!raw || typeof raw !== "object") return null;
  if (kind === "distill") {
    const d = raw as Partial<DistillOutput>;
    if (Array.isArray(d.keywords) && Array.isArray(d.research_directions)) return d as DistillOutput;
    return null;
  }
  if (kind === "critic") {
    const c = raw as Partial<CriticOutput>;
    if (Array.isArray(c.warnings)) return c as CriticOutput;
    return null;
  }
  const k = raw as Partial<CounterOutput>;
  if (Array.isArray(k.axes) || Array.isArray(k.suggestions)) return k as CounterOutput;
  return null;
}

export async function runDistill(
  env: Env,
  params: RadarParams,
  opts: { redistillOf?: string; keepElements?: string[]; promptVariant?: PromptVariant } = {}
): Promise<DistillRunResult> {
  const budgetUsedPct = await budgetPct(env);
  if (budgetUsedPct >= 100) {
    return { ok: false, error: `monthly_budget_exhausted (${budgetUsedPct.toFixed(0)}% of $${env.MONTHLY_BUDGET_USD})`, budgetUsedPct };
  }

  const ctx: DistillContext = await buildDistillContext(env, params);

  let parentOutput: DistillOutput | null = null;
  if (opts.redistillOf) {
    const parent = await env.DB
      .prepare("SELECT output_json FROM distill_sessions WHERE id = ?")
      .bind(opts.redistillOf)
      .first<{ output_json: string }>();
    if (parent?.output_json) {
      try {
        parentOutput = JSON.parse(parent.output_json) as DistillOutput;
      } catch {
        parentOutput = null;
      }
    }
  }

  const keep = opts.keepElements ?? [];
  const keepNote = parentOutput
    ? `\nThis is a RE-DISTILL. The user selected these elements from the previous edition to KEEP unchanged — carry them over verbatim and regenerate the rest with fresh angles:\n${JSON.stringify(
        Object.fromEntries(keep.map((k) => [k, (parentOutput as unknown as Record<string, unknown>)[k]]).filter(([, v]) => v !== undefined))
      )}`
    : "";

  const sys = "You are Distill, a precise research synthesis engine. Output only valid JSON.";

  const variant = opts.promptVariant ?? DEFAULT_PROMPT_VARIANT;

  const distillRes = await callOpenAi(env, {
    purpose: "distill",
    model: "high",
    jsonMode: true,
    maxOutputTokens: 4000,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: distillPrompt(ctx, variant) + keepNote },
    ],
  });
  const distill = asValidated(extractJsonLoose(distillRes.text), "distill");
  if (!distill) throw new Error("distill_invalid_output");

  const [criticRes, counterRes] = await Promise.all([
    callOpenAi(env, {
      purpose: "critic",
      model: "high",
      jsonMode: true,
      maxOutputTokens: 3000,
      messages: [
        { role: "system", content: "You are Critic. Output only valid JSON. Be terse." },
        { role: "user", content: criticPrompt(JSON.stringify(distill, null, 1)) },
      ],
    }),
    callOpenAi(env, {
      purpose: "counter",
      model: "high",
      jsonMode: true,
      maxOutputTokens: 3000,
      messages: [
        { role: "system", content: "You are Counter. Output only valid JSON. Be terse." },
        { role: "user", content: counterPrompt(JSON.stringify(distill, null, 1), params.counterStrength) },
      ],
    }),
  ]);

  const critic = asValidated(extractJsonLoose(criticRes.text), "critic") ?? { warnings: [], overall: "critic_parse_failed" };
  const counter = asValidated(extractJsonLoose(counterRes.text), "counter") ?? { axes: [], suggestions: [] };

  const totalCost = distillRes.costUsd + criticRes.costUsd + counterRes.costUsd;
  const sessionId = uuid();
  const ts = new Date().toISOString();

  const queueIds = indexQueueItems(env, sessionId, distill, ts);

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO distill_sessions
         (id, input_context_json, sources_used_json, output_json, critic_output_json, counter_output_json,
          user_selection_json, redistill_of, model_version, prompt_version, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        JSON.stringify(ctx),
        JSON.stringify(ctx.sources.map((s) => ({ id: s.id, title: s.title }))),
        JSON.stringify(distill),
        JSON.stringify(critic),
        JSON.stringify(counter),
        opts.redistillOf ?? null,
        distillRes.model,
        variant,
        totalCost,
        ts
      ),
    ...queueIds.stmts,
    ...indexGaps(env, sessionId, distill, ts),
  ]);

  return { ok: true, sessionId, costUsd: totalCost, budgetUsedPct: await budgetPct(env), queueItemIds: queueIds.ids, distillOutput: distill };
}

export async function verifyQueueItems(env: Env, d: DistillOutput, ids: string[]): Promise<void> {
  const items = d.read_next ?? [];
  for (let i = 0; i < items.length && i < ids.length; i++) {
    const item = items[i];
    if (!item?.title) continue;
    const work = await verifyWork(item.title, item.author ?? null);
    if (work) {
      await env.DB
        .prepare(
          `UPDATE reading_queue SET verified = 1, verified_at = ?, openalex_id = ?, source_url = COALESCE(?, source_url)
           WHERE id = ?`
        )
        .bind(new Date().toISOString(), work.id, work.openAccessUrl ?? work.doi ?? null, ids[i])
        .run();
    }
  }
}

function indexQueueItems(env: Env, sessionId: string, d: DistillOutput, ts: string): { stmts: D1PreparedStatement[]; ids: string[] } {
  const stmts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const item of d.read_next ?? []) {
    if (!item?.title) continue;
    const id = uuid();
    ids.push(id);
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO reading_queue (id, distill_session_id, title, author, source_url, openalex_id, priority, why_read, related_question, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, 'WORTH', ?, ?, ?)`
        )
        .bind(id, sessionId, item.title.slice(0, 300), item.author ?? null, item.why_read ?? null, item.related_question ?? null, ts)
    );
  }
  return { stmts, ids };
}

function indexGaps(env: Env, sessionId: string, d: DistillOutput, ts: string): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const g of d.research_gaps ?? []) {
    if (!g?.gap) continue;
    stmts.push(
      env.DB
        .prepare(`INSERT INTO research_gaps (id, distill_session_id, gap_text, kind, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(uuid(), sessionId, g.gap.slice(0, 800), g.kind ?? null, ts)
    );
  }
  return stmts;
}

export async function budgetPct(env: Env): Promise<number> {
  const spent = await monthSpendUsd(env);
  return (spent / Math.max(parseFloat(env.MONTHLY_BUDGET_USD) || 10, 0.01)) * 100;
}
