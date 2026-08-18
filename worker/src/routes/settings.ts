import { Hono } from "hono";
import homepageProjects from "../data/homepage-projects.json";
import { createSource } from "../ingestion/store";

const settings = new Hono<{ Bindings: Env }>();

interface HomepageProject {
  slug: string;
  title: string;
  year: number | null;
  projectUrl: string;
  statement: string | null;
  imageCount: number;
  videoUrls: string[];
}

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
    if (r.duplicateOf) duplicates++;
    else imported++;
    results.push({ slug: p.slug, sourceId: r.sourceId, duplicate: Boolean(r.duplicateOf) });
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

export default settings;
