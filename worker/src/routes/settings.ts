import { Hono } from "hono";
import { PRESETS, type PresetName, type RadarParams } from "@radar/shared";
import homepageProjects from "../data/homepage-projects.json";
import { analyzeSource } from "../analysis/analyze";
import { createSource } from "../ingestion/store";
import { PARAMS_KEY, loadParams } from "../lib/params";

const settings = new Hono<{ Bindings: Env }>();

const VALID_PRESETS = Object.keys(PRESETS) as PresetName[];

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
