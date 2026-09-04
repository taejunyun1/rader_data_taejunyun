import { Hono } from "hono";
import { budgetPct, verifyQueueItems } from "../distill/run";
import { PROMPT_VARIANTS, type DistillOutput, type PromptVariant } from "../distill/prompts";
import { parseDistillOutput, sanitizeDistillDetails } from "../distill/outputSchema";
import { enqueueResearchJob } from "../jobs/enqueue";
import { verifiedRequester } from "../lib/httpErrors";
import { readJson } from "../lib/requestBody";

const distill = new Hono<{ Bindings: Env }>();

function homepagePublicationState(value: unknown): string {
  switch (value) {
    case "PUBLISHED": return "CURRENT";
    case "SUPERSEDED": return "SUPERSEDED";
    case "WITHDRAWN": return "WITHDRAWN";
    case "FAILED": return "FAILED";
    case "PURGING": return "PURGING";
    case "PURGED": return "PURGED";
    default: return "NONE";
  }
}

interface SourceSnapshot {
  id: string;
  title: string;
}

interface DetailSource {
  id: string;
  title: string;
  available: boolean;
}

function parseSourceSnapshots(value: unknown): SourceSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return typeof row.id === "string" && row.id && typeof row.title === "string"
      ? [{ id: row.id, title: row.title }]
      : [];
  });
}

function sanitizedOutput(value: unknown, snapshots: SourceSnapshot[]): DistillOutput | null {
  const output = parseDistillOutput(value);
  return output ? sanitizeDistillDetails(output, new Set(snapshots.map((source) => source.id))) : null;
}

function detailSourceIds(output: DistillOutput | null): string[] {
  if (!output?.details) return [];
  const ids = [
    ...output.details.thoughts,
    ...output.details.questions,
    ...output.details.researchGaps,
    ...output.details.researchDirections,
    ...output.details.artworkDirections,
  ].flatMap((item) => item.sourceIds);
  return [...new Set(ids)];
}

async function resolveDetailSources(db: D1Database, snapshots: SourceSnapshot[], output: unknown): Promise<DetailSource[]> {
  const ids = detailSourceIds(sanitizedOutput(output, snapshots));
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db.prepare(`SELECT id, title FROM sources WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; title: string }>();
  const active = new Map((rows.results ?? []).map((row) => [row.id, row.title]));
  const snapshotTitles = new Map(snapshots.map((source) => [source.id, source.title]));
  return ids.map((id) => ({ id, title: active.get(id) ?? snapshotTitles.get(id) ?? id, available: active.has(id) }));
}

function detailSourceLabel(ids: string[], snapshots: SourceSnapshot[]): string {
  const titles = new Map(snapshots.map((source) => [source.id, source.title]));
  return ids.map((id) => titles.get(id) ?? id).join(", ");
}

function appendDetail(lines: string[], heading: string, summary: string, fields: Array<[string, string]>, sourceIds: string[], snapshots: SourceSnapshot[]): void {
  lines.push(`### ${heading}`, ``, `**요약**: ${summary}`, ``);
  for (const [label, value] of fields) lines.push(`- ${label}: ${value}`);
  if (sourceIds.length) lines.push(`- 출처: ${detailSourceLabel(sourceIds, snapshots)}`);
  lines.push(``);
}

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
  const body = (await readJson<{ redistillOf?: string; keepElements?: string[]; promptVariant?: string; includeCounter?: boolean }>(c)) ?? {};
  const variant: PromptVariant | undefined = PROMPT_VARIANTS.includes(body.promptVariant as PromptVariant)
    ? (body.promptVariant as PromptVariant)
    : undefined;
  try {
    const requestedBy = verifiedRequester(c);
    const result = await enqueueResearchJob(c.env, { kind: "DISTILL_RUN", input: {
      redistillOf: body.redistillOf,
      keepElements: body.keepElements,
      promptVariant: variant,
      includeCounter: body.includeCounter !== false,
    } }, requestedBy);
    return c.json(result, 202);
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
    `SELECT session.id, session.redistill_of AS redistillOf, session.counter_enabled AS counterEnabled,
            session.cost_usd AS costUsd, session.model_version AS modelVersion,
            session.prompt_version AS promptVersion, session.created_at AS createdAt,
            CASE WHEN session.sources_used_json IS NULL THEN NULL
                 WHEN json_valid(session.sources_used_json) THEN json_array_length(session.sources_used_json)
                 ELSE 0 END AS sourceCount,
            CASE WHEN session.sources_used_json IS NULL THEN NULL
                 ELSE (
                   SELECT COUNT(*)
                   FROM json_each(CASE WHEN json_valid(session.sources_used_json) THEN session.sources_used_json ELSE '[]' END) used
                   JOIN sources active_source ON active_source.id = json_extract(used.value, '$.id')
                 ) END AS activeSourceCount,
            COALESCE((SELECT status FROM homepage_publications publication
                      WHERE publication.distill_session_id = session.id
                      ORDER BY publication.updated_at DESC LIMIT 1), 'NONE') AS homepagePublicationState
     FROM distill_sessions session ORDER BY session.created_at DESC LIMIT 30`
  ).all<Record<string, unknown>>();
  return c.json({ sessions: (rows.results ?? []).map((row) => ({ ...row, homepagePublicationState: homepagePublicationState(row.homepagePublicationState) })) });
});

distill.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB
    .prepare(
      `SELECT id, input_context_json, sources_used_json, output_json, critic_output_json, counter_output_json,
              counter_enabled AS counterEnabled, user_selection_json, redistill_of AS redistillOf, model_version AS modelVersion,
              prompt_version AS promptVersion, cost_usd AS costUsd, created_at AS createdAt,
              COALESCE((SELECT status FROM homepage_publications publication
                        WHERE publication.distill_session_id = distill_sessions.id
                        ORDER BY publication.updated_at DESC LIMIT 1), 'NONE') AS homepagePublicationState
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
  const sourcesUsed = parse(row.sources_used_json);
  const sourceSnapshots = parseSourceSnapshots(sourcesUsed);
  const output = sanitizedOutput(parse(row.output_json), sourceSnapshots);
  const detailSources = await resolveDetailSources(c.env.DB, sourceSnapshots, output);

  return c.json({
    session: {
      id: row.id,
      redistillOf: row.redistillOf,
      counterEnabled: row.counterEnabled === 1 || row.counterEnabled === "1" || row.counterEnabled === true,
      modelVersion: row.modelVersion,
      promptVersion: row.promptVersion,
      costUsd: row.costUsd,
      createdAt: row.createdAt,
      sourcesUsed,
      output,
      critic: parse(row.critic_output_json),
      counter: parse(row.counter_output_json),
      homepagePublicationState: homepagePublicationState(row.homepagePublicationState),
      userSelection: parse(row.user_selection_json),
    },
    readingQueue: queue.results ?? [],
    researchGaps: gaps.results ?? [],
    detailSources,
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
  const body = await readJson<{ kept?: string[]; note?: string }>(c);
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
    .prepare("SELECT output_json, sources_used_json, critic_output_json, counter_output_json, counter_enabled, created_at FROM distill_sessions WHERE id = ?")
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

  const rawOutput = parse<DistillOutput>(row.output_json);
  const snapshots = parseSourceSnapshots(parse(row.sources_used_json));
  const parsedOutput = rawOutput ? sanitizedOutput(rawOutput, snapshots) : null;
  const details = parsedOutput?.details;
  const appendDetails = () => {
    if (!details) return;
    lines.push(`## 상세 근거와 맥락`, ``, `각 요약 항목의 근거·불확실성·다음 확인 지점을 기록한 Radar 내부 메모입니다.`, ``);
    for (const item of details.thoughts) {
      const summary = parsedOutput?.thoughts_fragments[item.summaryIndex] ?? "";
      appendDetail(lines, `생각의 조각 ${item.summaryIndex + 1}`, summary, [
        ["근거", item.rationale], ["불확실성", item.uncertainty], ["다음 확인", item.nextCheck],
      ], item.sourceIds, snapshots);
    }
    for (const item of details.questions) {
      const summary = parsedOutput?.questions[item.summaryIndex] ?? "";
      appendDetail(lines, `질문 ${item.summaryIndex + 1}`, summary, [
        ["지금 묻는 이유", item.whyNow], ["조사 방법", item.method], ["필요한 증거", item.evidenceNeeded],
      ], item.sourceIds, snapshots);
    }
    for (const item of details.researchGaps) {
      const summary = parsedOutput?.research_gaps[item.summaryIndex]?.gap ?? "";
      appendDetail(lines, `연구 공백 ${item.summaryIndex + 1}`, summary, [
        ["진단", item.diagnosis], ["연구 방법", item.researchMethod],
      ], item.sourceIds, snapshots);
    }
    for (const item of details.researchDirections) {
      const summary = parsedOutput?.research_directions[item.summaryIndex] ?? "";
      appendDetail(lines, `연구 방향 ${item.summaryIndex + 1}`, summary, [
        ["근거", item.rationale], ["방법", item.method], ["예상 결과", item.expectedOutcome],
      ], item.sourceIds, snapshots);
    }
    for (const item of details.artworkDirections) {
      const summary = parsedOutput?.artwork_directions[item.summaryIndex] ?? "";
      appendDetail(lines, `작업 방향 ${item.summaryIndex + 1}`, summary, [
        ["근거", item.rationale], ["재료", item.materials.join(", ")], ["절차", item.procedure], ["관찰", item.observation],
      ], item.sourceIds, snapshots);
    }
  };
  const legacyOutput = parse<{
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
  const counter = parse<{ dominant_claim?: string; opposing_thesis?: string; axes?: { from: string; to: string }[]; suggestions?: { direction: string; grounding?: { name: string; kind: string; note: string }[] }[] }>(row.counter_output_json);

  const date = String(row.created_at ?? "").slice(0, 10);
  const lines: string[] = [`---`, `source: research-radar`, `session: ${id}`, `date: ${date}`, `---`, ``, `# Research Radar Distill — ${date}`, ``];

  if (legacyOutput?.keywords?.length) lines.push(`**키워드**: ${legacyOutput.keywords.join(", ")}`, ``);
  if (legacyOutput?.thoughts_fragments?.length) {
    lines.push(`## Thoughts`, ``);
    for (const t of legacyOutput.thoughts_fragments) lines.push(`- ${t}`);
    lines.push(``);
  }
  if (legacyOutput?.questions?.length) {
    lines.push(`## Questions`, ``);
    for (const q of legacyOutput.questions) lines.push(`- ${q}`);
    lines.push(``);
  }
  if (legacyOutput?.read_next?.length) {
    lines.push(`## Read Next`, ``);
    for (const r of legacyOutput.read_next) lines.push(`- **${r.title}**${r.author ? ` — ${r.author}` : ""}: ${r.why_read}`);
    lines.push(``);
  }
  if (legacyOutput?.research_gaps?.length) {
    lines.push(`## Research Gaps`, ``);
    for (const g of legacyOutput.research_gaps) lines.push(`- ${g.gap} [${g.kind}]`);
    lines.push(``);
  }
  if (legacyOutput?.research_directions?.length) {
    lines.push(`## Research Directions`, ``);
    for (const d of legacyOutput.research_directions) lines.push(`- ${d}`);
    lines.push(``);
  }
  if (legacyOutput?.artwork_directions?.length) {
    lines.push(`## Artwork Directions`, ``);
    for (const d of legacyOutput.artwork_directions) lines.push(`- ${d}`);
    lines.push(``);
  }
  if (legacyOutput?.small_experiment) lines.push(`## Small Experiment`, ``, legacyOutput.small_experiment, ``);
  appendDetails();
  if (critic) {
    lines.push(`## Critic`, ``, `_${critic.overall ?? ""}_`, ``);
    for (const w of critic.warnings ?? []) lines.push(`- ⚠ [${w.category}] ${w.note}`);
    lines.push(``);
  }
  if (counter) {
    lines.push(`## Counter`, ``);
    if (counter.dominant_claim) lines.push(`**현재 중심 주장**: ${counter.dominant_claim}`, ``);
    if (counter.opposing_thesis) lines.push(`**정반대 명제**: ${counter.opposing_thesis}`, ``);
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
