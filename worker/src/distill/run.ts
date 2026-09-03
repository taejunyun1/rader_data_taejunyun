import type { RadarParams } from "@radar/shared";
import { uuid } from "../ingestion/ids";
import { callOpenAi, monthSpendUsd } from "../lib/openai";
import { verifyWork } from "../lib/openalex";
import { buildDistillContext, type DistillContext } from "./context";
import {
  counterPrompt,
  criticPrompt,
  counterValidationPrompt,
  DEFAULT_PROMPT_VARIANT,
  distillPrompt,
  extractJsonLoose,
  type CounterOutput,
  type CriticOutput,
  type DistillOutput,
  type PromptVariant,
} from "./prompts";
import { parseCriticOutput, parseCounterOutput, parseDistillOutput } from "./outputSchema";

export type DistillRunResult =
  | { ok: true; sessionId: string; costUsd: number; budgetUsedPct: number; queueItemIds: string[]; distillOutput: DistillOutput }
  | { ok: false; error: string; budgetUsedPct: number };

function asValidated<T>(raw: unknown, kind: "distill"): DistillOutput | null;
function asValidated(raw: unknown, kind: "critic"): CriticOutput | null;
function asValidated(raw: unknown, kind: "counter"): CounterOutput | null;
function asValidated(raw: unknown, kind: string): unknown {
  if (kind === "distill") return parseDistillOutput(raw);
  if (kind === "critic") return parseCriticOutput(raw);
  return parseCounterOutput(raw);
}

export async function runDistill(
  env: Env,
  params: RadarParams,
  opts: { redistillOf?: string; keepElements?: string[]; promptVariant?: PromptVariant; includeCounter?: boolean; researchJobId?: string } = {}
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
        parentOutput = parseDistillOutput(JSON.parse(parent.output_json));
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
  const includeCounter = opts.includeCounter ?? true;

  const distillRes = await callOpenAi(env, {
    purpose: "distill",
    researchJobId: opts.researchJobId,
    workflowStep: "distill-primary",
    promptVersion: variant,
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

  const criticRes = await callOpenAi(env, {
      purpose: "critic",
      researchJobId: opts.researchJobId,
      workflowStep: "distill-critic",
      promptVersion: variant,
      model: "deep",
      jsonMode: true,
      maxOutputTokens: 3000,
      messages: [
        { role: "system", content: "You are Critic. Output only valid JSON. Be terse." },
        { role: "user", content: criticPrompt(JSON.stringify(distill, null, 1)) },
      ],
    });

  const critic = asValidated(extractJsonLoose(criticRes.text), "critic") ?? { warnings: [], overall: "critic_parse_failed" };
  const counterRun = includeCounter ? await runCounter(env, distill, critic, ctx, params.counterStrength, opts.researchJobId) : null;
  const counter = counterRun?.output ?? null;

  const totalCost = distillRes.costUsd + criticRes.costUsd + (counterRun?.costUsd ?? 0);
  const sessionId = uuid();
  const ts = new Date().toISOString();

  const queueIds = indexQueueItems(env, sessionId, distill, ts);

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO distill_sessions
         (id, input_context_json, sources_used_json, output_json, critic_output_json, counter_output_json,
          counter_enabled, user_selection_json, redistill_of, model_version, prompt_version, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      )
      .bind(
        sessionId,
        JSON.stringify(ctx),
        JSON.stringify(ctx.sources.map((s) => ({ id: s.id, title: s.title }))),
        JSON.stringify(distill),
        JSON.stringify(critic),
        counter ? JSON.stringify(counter) : null,
        includeCounter ? 1 : 0,
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

async function runCounter(
  env: Env,
  distill: DistillOutput,
  critic: CriticOutput,
  ctx: DistillContext,
  counterStrength: number,
  researchJobId?: string,
): Promise<{ output: CounterOutput; costUsd: number }> {
  const distillJson = JSON.stringify(distill, null, 1);
  const sourceEvidence = [`CRITIC REVIEW:\n${JSON.stringify(critic)}`, ...ctx.sources.map((source) => `${source.title}\n${source.summary ?? ""}\n${source.fragments.map((f) => `- ${f}`).join("\n")}`)].join("\n\n").slice(0, 12_000);
  const generated = await callOpenAi(env, {
    purpose: "counter",
    researchJobId,
    workflowStep: "distill-counter",
    promptVersion: "counter-v1",
    model: "high",
    jsonMode: true,
    maxOutputTokens: 3200,
    messages: [
      { role: "system", content: "You are Counter. Output only valid JSON. Be terse but logically explicit." },
      { role: "user", content: counterPrompt(distillJson, counterStrength, sourceEvidence) },
    ],
  });
  let output = asValidated(extractJsonLoose(generated.text), "counter");
  if (!output) return { output: { axes: [], suggestions: [], validation: { status: "unverified", issues: ["Counter JSON을 해석하지 못했습니다."] } }, costUsd: generated.costUsd };

  const validation = await validateCounter(env, distillJson, output, sourceEvidence, researchJobId, "distill-counter-validation");
  let totalCost = generated.costUsd + validation.costUsd;
  if (validation.status === "verified") return { output: { ...output, validation: validation.result }, costUsd: totalCost };

  const repaired = await callOpenAi(env, {
    purpose: "counter",
    researchJobId,
    workflowStep: "distill-counter-repair",
    promptVersion: "counter-v1",
    model: "deep",
    jsonMode: true,
    maxOutputTokens: 3200,
    messages: [
      { role: "system", content: "You are Counter repair. Output only valid JSON." },
      { role: "user", content: counterPrompt(distillJson, counterStrength, sourceEvidence, validation.result.issues.join("\n")) },
    ],
  });
  totalCost += repaired.costUsd;
  output = asValidated(extractJsonLoose(repaired.text), "counter") ?? output;
  const repairedValidation = await validateCounter(env, distillJson, output, sourceEvidence, researchJobId, "distill-counter-validation-repair");
  totalCost += repairedValidation.costUsd;
  return {
    output: {
      ...output,
      validation: {
        ...repairedValidation.result,
        status: repairedValidation.status === "verified" ? "corrected" : "unverified",
      },
    },
    costUsd: totalCost,
  };
}

async function validateCounter(env: Env, distillJson: string, counter: CounterOutput, sourceEvidence: string, researchJobId?: string, workflowStep = "distill-counter-validation"): Promise<{ status: "verified" | "unverified"; result: NonNullable<CounterOutput["validation"]>; costUsd: number }> {
  const response = await callOpenAi(env, {
    purpose: "counter_validation",
    researchJobId,
    workflowStep,
    promptVersion: "counter-v1",
    model: "deep",
    jsonMode: true,
    maxOutputTokens: 1600,
    messages: [
      { role: "system", content: "You verify a research counterargument. Output only valid JSON." },
      { role: "user", content: counterValidationPrompt(distillJson, JSON.stringify(counter, null, 1), sourceEvidence) },
    ],
  });
  const raw = extractJsonLoose(response.text) as Record<string, unknown> | null;
  const scores = raw?.scores && typeof raw.scores === "object" ? raw.scores as Record<string, unknown> : {};
  const parsedScores = {
    directOpposition: numberScore(scores.directOpposition),
    internalConsistency: numberScore(scores.internalConsistency),
    sourceTraceability: numberScore(scores.sourceTraceability),
    groundingIntegrity: numberScore(scores.groundingIntegrity),
    nonStrawman: numberScore(scores.nonStrawman),
  };
  const issues = Array.isArray(raw?.issues) ? raw.issues.filter((item): item is string => typeof item === "string").slice(0, 6) : ["Counter 검증 결과가 불완전합니다."];
  const verified = raw?.status === "verified" && Object.values(parsedScores).every((score) => score >= 0.75);
  return { status: verified ? "verified" : "unverified", result: { status: verified ? "verified" : "unverified", issues, scores: parsedScores }, costUsd: response.costUsd };
}

function numberScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
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
