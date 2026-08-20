import { Hono } from "hono";
import { loadParams } from "../lib/params";
import { budgetPct, runDistill, verifyQueueItems } from "../distill/run";
import { PROMPT_VARIANTS, type DistillOutput, type PromptVariant } from "../distill/prompts";

const distill = new Hono<{ Bindings: Env }>();

distill.get("/budget", async (c) => {
  const pct = await budgetPct(c.env);
  return c.json({
    usedPct: Math.round(pct * 10) / 10,
    budgetUsd: parseFloat(c.env.MONTHLY_BUDGET_USD) || 10,
    blocked: pct >= 100,
    warn: pct >= 80,
  });
});

distill.post("/run", async (c) => {
  const body = (await c.req.json<{ redistillOf?: string; keepElements?: string[]; promptVariant?: string }>().catch(() => ({}))) as {
    redistillOf?: string;
    keepElements?: string[];
    promptVariant?: string;
  };
  const variant: PromptVariant | undefined = PROMPT_VARIANTS.includes(body.promptVariant as PromptVariant)
    ? (body.promptVariant as PromptVariant)
    : undefined;
  const params = await loadParams(c.env.DB);
  try {
    const result = await runDistill(c.env, params, {
      redistillOf: body.redistillOf,
      keepElements: body.keepElements,
      promptVariant: variant,
    });
    if (!result.ok) return c.json(result, 429);
    c.executionCtx.waitUntil(
      verifyQueueItems(c.env, result.distillOutput, result.queueItemIds).catch((e) =>
        console.warn(JSON.stringify({ level: "warn", scope: "queue-verify", message: (e as Error).message }))
      )
    );
    return c.json(result);
  } catch (err) {
    const message = (err as Error).message.slice(0, 300);
    console.error(JSON.stringify({ level: "error", scope: "distill:run", message }));
    return c.json({ ok: false, error: message }, 500);
  }
});

distill.post("/verify-queue/:id", async (c) => {
  const id = c.req.param("id");
  const rows = await c.env.DB
    .prepare(`SELECT id, title, author FROM reading_queue WHERE distill_session_id = ? AND verified = 0`)
    .bind(id)
    .all<{ id: string; title: string; author: string | null }>();
  const items = rows.results ?? [];
  if (!items.length) return c.json({ verified: 0 });
  const fake: DistillOutput = {
    keywords: [],
    thoughts_fragments: [],
    questions: [],
    read_next: items.map((r) => ({ title: r.title, author: r.author ?? undefined, why_read: "", related_question: undefined })),
    research_gaps: [],
    research_directions: [],
    artwork_directions: [],
  };
  await verifyQueueItems(c.env, fake, items.map((r) => r.id));
  const after = await c.env.DB
    .prepare(`SELECT COUNT(*) AS n FROM reading_queue WHERE distill_session_id = ? AND verified = 1`)
    .bind(id)
    .first<{ n: number }>();
  return c.json({ verified: after?.n ?? 0, total: items.length });
});

distill.get("/sessions", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, redistill_of AS redistillOf, cost_usd AS costUsd, model_version AS modelVersion,
            prompt_version AS promptVersion, created_at AS createdAt
     FROM distill_sessions ORDER BY created_at DESC LIMIT 30`
  ).all<Record<string, unknown>>();
  return c.json({ sessions: rows.results ?? [] });
});

distill.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare(
      `SELECT id, input_context_json, sources_used_json, output_json, critic_output_json, counter_output_json,
              user_selection_json, redistill_of AS redistillOf, model_version AS modelVersion,
              prompt_version AS promptVersion, cost_usd AS costUsd, created_at AS createdAt
       FROM distill_sessions WHERE id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) return c.json({ error: "not_found" }, 404);

  const parse = (v: unknown): unknown => {
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };

  const [queue, gaps] = await Promise.all([
    c.env.DB
      .prepare(
        `SELECT id, title, author, priority, why_read AS whyRead, related_question AS relatedQuestion,
                source_url AS sourceUrl, openalex_id AS openalexId, verified
         FROM reading_queue WHERE distill_session_id = ?`
      )
      .bind(id)
      .all<Record<string, unknown>>(),
    c.env.DB
      .prepare(`SELECT id, gap_text AS gap, kind FROM research_gaps WHERE distill_session_id = ?`)
      .bind(id)
      .all<Record<string, unknown>>(),
  ]);

  return c.json({
    session: {
      id: row.id,
      redistillOf: row.redistillOf,
      modelVersion: row.modelVersion,
      promptVersion: row.promptVersion,
      costUsd: row.costUsd,
      createdAt: row.createdAt,
      sourcesUsed: parse(row.sources_used_json),
      output: parse(row.output_json),
      critic: parse(row.critic_output_json),
      counter: parse(row.counter_output_json),
      userSelection: parse(row.user_selection_json),
    },
    readingQueue: queue.results ?? [],
    researchGaps: gaps.results ?? [],
  });
});

distill.post("/queue-import/:itemId", async (c) => {
  const itemId = c.req.param("itemId");
  const item = await c.env.DB
    .prepare("SELECT title, author, openalex_id AS openalexId FROM reading_queue WHERE id = ?")
    .bind(itemId)
    .first<{ title: string; author: string | null; openalexId: string | null }>();
  if (!item) return c.json({ error: "not_found" }, 404);

  const { importQueuedItem } = await import("../distill/queueImport");
  const result = await importQueuedItem(c.env, item);
  return c.json(result, result.status === "failed" ? 500 : 200);
});

distill.post("/sessions/:id/select", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ kept?: string[]; note?: string }>().catch(() => null);
  if (!body?.kept) return c.json({ error: "kept_required" }, 400);
  const ts = new Date().toISOString();
  await c.env.DB
    .prepare("UPDATE distill_sessions SET user_selection_json = ?, created_at = created_at WHERE id = ?")
    .bind(JSON.stringify({ kept: body.kept, note: body.note ?? null, at: ts }), id)
    .run();
  return c.json({ ok: true });
});

distill.get("/sessions/:id/markdown", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare("SELECT output_json, critic_output_json, counter_output_json, created_at FROM distill_sessions WHERE id = ?")
    .bind(id)
    .first<Record<string, string | null>>();
  if (!row) return c.json({ error: "not_found" }, 404);

  const parse = <T,>(v: string | null | undefined): T | null => {
    if (!v) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  };

  const o = parse<{
    keywords?: string[];
    thoughts_fragments?: string[];
    questions?: string[];
    read_next?: { title: string; author?: string; why_read: string }[];
    research_gaps?: { gap: string; kind: string }[];
    research_directions?: string[];
    artwork_directions?: string[];
    small_experiment?: string;
  }>(row.output_json);
  const critic = parse<{ warnings?: { category: string; note: string }[]; overall?: string }>(row.critic_output_json);
  const counter = parse<{ axes?: { from: string; to: string }[]; suggestions?: { direction: string; grounding?: { name: string; kind: string; note: string }[] }[] }>(row.counter_output_json);

  const date = String(row.created_at ?? "").slice(0, 10);
  const lines: string[] = [`---`, `source: research-radar`, `session: ${id}`, `date: ${date}`, `---`, ``, `# Research Radar Distill — ${date}`, ``];

  if (o?.keywords?.length) lines.push(`**키워드**: ${o.keywords.join(", ")}`, ``);
  if (o?.thoughts_fragments?.length) {
    lines.push(`## Thoughts`, ``);
    for (const t of o.thoughts_fragments) lines.push(`- ${t}`);
    lines.push(``);
  }
  if (o?.questions?.length) {
    lines.push(`## Questions`, ``);
    for (const q of o.questions) lines.push(`- ${q}`);
    lines.push(``);
  }
  if (o?.read_next?.length) {
    lines.push(`## Read Next`, ``);
    for (const r of o.read_next) lines.push(`- **${r.title}**${r.author ? ` — ${r.author}` : ""}: ${r.why_read}`);
    lines.push(``);
  }
  if (o?.research_gaps?.length) {
    lines.push(`## Research Gaps`, ``);
    for (const g of o.research_gaps) lines.push(`- ${g.gap} [${g.kind}]`);
    lines.push(``);
  }
  if (o?.research_directions?.length) {
    lines.push(`## Research Directions`, ``);
    for (const d of o.research_directions) lines.push(`- ${d}`);
    lines.push(``);
  }
  if (o?.artwork_directions?.length) {
    lines.push(`## Artwork Directions`, ``);
    for (const d of o.artwork_directions) lines.push(`- ${d}`);
    lines.push(``);
  }
  if (o?.small_experiment) lines.push(`## Small Experiment`, ``, o.small_experiment, ``);
  if (critic) {
    lines.push(`## Critic`, ``, `_${critic.overall ?? ""}_`, ``);
    for (const w of critic.warnings ?? []) lines.push(`- ⚠ [${w.category}] ${w.note}`);
    lines.push(``);
  }
  if (counter) {
    lines.push(`## Counter`, ``);
    for (const a of counter.axes ?? []) lines.push(`- ${a.from} → ${a.to}`);
    lines.push(``);
    for (const s of counter.suggestions ?? []) {
      lines.push(`**${s.direction}**`, ``);
      for (const g of s.grounding ?? []) lines.push(`- ${g.name} (${g.kind}): ${g.note}`);
      lines.push(``);
    }
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="radar-distill-${date}.md"`,
    },
  });
});

export default distill;
