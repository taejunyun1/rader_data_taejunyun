import { Hono } from "hono";
import { PRESETS, type PresetName, type RadarParams } from "@radar/shared";
import homepageProjects from "../data/homepage-projects.json";
import { analyzeSource } from "../analysis/analyze";
import { createSource } from "../ingestion/store";
import { PARAMS_KEY, loadParams } from "../lib/params";
import { callOpenAi } from "../lib/openai";
import { isSelectableModelId, listAvailableModels, loadModelRoles, saveModelRoles, type AvailableModel } from "../lib/modelSettings";

const settings = new Hono<{ Bindings: Env }>();

const VALID_PRESETS = Object.keys(PRESETS) as PresetName[];

settings.get("/models", async (c) => {
  const roles = await loadModelRoles(c.env.DB, c.env);
  try {
    const models = await listAvailableModels(c.env);
    return c.json({ roles, models });
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", scope: "settings:models", reason: (error as Error).message }));
    return c.json({ roles, models: [], error: "model_list_unavailable" });
  }
});

settings.post("/models/test", async (c) => {
  const body = await c.req.json<{ modelId?: string }>().catch(() => null);
  const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
  if (!isSelectableModelId(modelId)) return c.json({ error: "invalid_model" }, 400);

  let models: AvailableModel[];
  try {
    models = await listAvailableModels(c.env);
  } catch (error) {
    return c.json({ error: "model_list_unavailable", detail: (error as Error).message }, 503);
  }
  if (!models.some((model) => model.id === modelId)) return c.json({ error: "model_unavailable" }, 400);

  try {
    const result = await callOpenAi(c.env, {
      purpose: "model_validation",
      modelId,
      jsonMode: true,
      maxOutputTokens: 32,
      messages: [
        { role: "system", content: "Return only valid JSON." },
        { role: "user", content: '{"ok":true}' },
      ],
    });
    return c.json({ ok: true, model: result.model, pricingKnown: result.pricingKnown, costUsd: result.costUsd });
  } catch (error) {
    return c.json({ ok: false, error: (error as Error).message.slice(0, 300) }, 502);
  }
});

settings.put("/models", async (c) => {
  const body = await c.req.json<{ baseModel?: string; reviewModel?: string }>().catch(() => null);
  const baseModel = typeof body?.baseModel === "string" ? body.baseModel.trim() : "";
  const reviewModel = typeof body?.reviewModel === "string" ? body.reviewModel.trim() : "";
  if (!isSelectableModelId(baseModel) || !isSelectableModelId(reviewModel)) return c.json({ error: "invalid_model" }, 400);

  let models: AvailableModel[];
  try {
    models = await listAvailableModels(c.env);
  } catch (error) {
    return c.json({ error: "model_list_unavailable", detail: (error as Error).message }, 503);
  }
  const available = new Set(models.map((model) => model.id));
  if (!available.has(baseModel) || !available.has(reviewModel)) return c.json({ error: "model_unavailable" }, 400);

  const roles = { baseModel, reviewModel };
  await saveModelRoles(c.env.DB, roles);
  return c.json(roles);
});

settings.get("/homepage", (c) => {
  const data = homepageProjects as {
    siteBase: string;
    extractedAt: string;
    projects: HomepageProject[];
  };
  return c.json({
    siteBase: data.siteBase,
    extractedAt: data.extractedAt,
    projects: data.projects.map((p) => ({
      slug: p.slug,
      title: p.title,
      year: p.year,
      projectUrl: p.projectUrl,
      imageCount: p.imageCount,
      videoCount: p.videoUrls.length,
    })),
  });
});

settings.get("/params", async (c) => {
  return c.json(await loadParams(c.env.DB));
});

settings.put("/params", async (c) => {
  const body = await c.req.json<Partial<RadarParams> & { preset?: string }>().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  let params: RadarParams;
  if (body.preset) {
    if (!VALID_PRESETS.includes(body.preset as PresetName)) return c.json({ error: "invalid_preset" }, 400);
    params = PRESETS[body.preset as PresetName];
  } else {
    const clamp01 = (v: unknown, fallback: number) => (typeof v === "number" && v >= 0 && v <= 1 ? v : fallback);
    const base = await loadParams(c.env.DB);
    params = {
      familiarity: clamp01(body.familiarity, base.familiarity),
      researchDepth: clamp01(body.researchDepth, base.researchDepth),
      divergence: clamp01(body.divergence, base.divergence),
      counterStrength: clamp01(body.counterStrength, base.counterStrength),
      technicalPhotographic: clamp01(body.technicalPhotographic, base.technicalPhotographic),
    };
  }

  const ts = new Date().toISOString();
  await c.env.DB
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(PARAMS_KEY, JSON.stringify(params), ts)
    .run();
  return c.json(params);
});

settings.post("/import-homepage", async (c) => {
  const { projects } = homepageProjects as { siteBase: string; projects: HomepageProject[] };
  let imported = 0;
  let duplicates = 0;
  const results: { slug: string; sourceId: string; duplicate: boolean }[] = [];

  for (const p of projects) {
    const text = [
      p.statement ? stripHtml(p.statement) : "",
      p.videoUrls.length ? `Videos: ${p.videoUrls.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const r = await createSource(c.env, {
      kind: "PERSONAL_WORK",
      title: p.title,
      authors: "Yun Taejun",
      year: p.year ?? undefined,
      canonicalUrl: p.projectUrl,
      origin: "homepage",
      original: text || p.title,
      extractedText: text,
      metadata: {
        slug: p.slug,
        imageCount: p.imageCount,
        videoUrls: p.videoUrls,
      },
    });
    if (!r.duplicateOf) await analyzeSource(c.env, r.sourceId);
    results.push({ slug: p.slug, sourceId: r.sourceId, duplicate: Boolean(r.duplicateOf) });
    if (r.duplicateOf) duplicates++;
    else imported++;
  }

  return c.json({ imported, duplicates, total: projects.length, results });
});

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|b|i|em|strong)[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface HomepageProject {
  slug: string;
  title: string;
  year: number | null;
  projectUrl: string;
  statement: string | null;
  imageCount: number;
  videoUrls: string[];
}

export default settings;
