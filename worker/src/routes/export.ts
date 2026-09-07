import { Hono } from "hono";
import { backupResearchOriginals, loadResearchExport } from "../lib/researchExport";

const exportRoute = new Hono<{ Bindings: Env }>();

interface SourceRow {
  id: string;
  kind: string;
  title: string;
  authors: string | null;
  year: number | null;
  canonical_url: string | null;
  doi: string | null;
  reliability: string;
  status: string;
  origin: string | null;
  r2_key: string | null;
  created_at: string;
}

async function loadSources(db: D1Database): Promise<SourceRow[]> {
  const rows = await db.prepare(
    `SELECT id, kind, title, authors, year, canonical_url, doi, reliability, status, origin, r2_key, created_at
     FROM sources ORDER BY created_at`
  ).all<SourceRow>();
  return rows.results ?? [];
}

exportRoute.get("/json", async (c) => {
  const payload = await loadResearchExport(c.env.DB);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="radar-export-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});

exportRoute.get("/csv", async (c) => {
  const sources = await loadSources(c.env.DB);
  const header = "id,kind,title,authors,year,reliability,status,origin,canonical_url,doi,created_at";
  const esc = (v: unknown) => {
    let text = String(v ?? "");
    // CSV quoting does not prevent spreadsheet formulas. Protect only the
    // exported cell; preserve the original metadata in storage and JSON.
    if (typeof v === "string" && (/^[\t\r\n]/.test(text) || /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(text))) {
      text = `'${text}`;
    }
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = sources.map((s) =>
    [s.id, s.kind, s.title, s.authors, s.year, s.reliability, s.status, s.origin, s.canonical_url, s.doi, s.created_at].map(esc).join(",")
  );
  return new Response([header, ...lines].join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="radar-sources-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
});

exportRoute.get("/markdown", async (c) => {
  const db = c.env.DB;
  const sources = await loadSources(db);
  const parts: string[] = [`# Research Radar — Markdown export`, ``, `_exported ${new Date().toISOString()}_`, ``];

  for (const s of sources) {
    parts.push(`## ${s.title}`, ``);
    parts.push(`- kind: ${s.kind} · reliability: ${s.reliability} · status: ${s.status}`);
    if (s.authors) parts.push(`- authors: ${s.authors}`);
    if (s.year) parts.push(`- year: ${s.year}`);
    if (s.canonical_url) parts.push(`- url: ${s.canonical_url}`);
    parts.push(`- added: ${s.created_at.slice(0, 10)}`, ``);

    const analysis = await db
      .prepare(`SELECT a.payload_json FROM source_analysis a JOIN sources s ON s.id = a.source_id
                WHERE a.source_id = ? AND a.analysis_type = 'basic' AND a.version_id = s.active_version_id
                ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`)
      .bind(s.id)
      .first<{ payload_json: string }>();
    if (analysis) {
      try {
        const a = JSON.parse(analysis.payload_json) as { summary?: string; keywords?: string[]; questions?: string[]; important_fragments?: string[] };
        if (a.summary) parts.push(`**Summary**`, ``, a.summary, ``);
        if (a.keywords?.length) parts.push(`**Keywords**: ${a.keywords.join(", ")}`, ``);
        if (a.questions?.length) {
          parts.push(`**Questions**`, ``);
          for (const q of a.questions) parts.push(`- ${q}`);
          parts.push(``);
        }
        if (a.important_fragments?.length) {
          parts.push(`**Fragments**`, ``);
          for (const f of a.important_fragments) parts.push(`> ${f}`);
          parts.push(``);
        }
      } catch {
        /* skip */
      }
    }

    const version = await db
      .prepare(`SELECT COALESCE(v.normalized_text, v.extracted_text) AS extracted_text
                FROM sources s JOIN source_versions v ON v.id = s.active_version_id
                WHERE s.id = ?`)
      .bind(s.id)
      .first<{ extracted_text: string | null }>();
    if (version?.extracted_text) {
      parts.push(`<details><summary>Extracted text</summary>`, ``, "```", version.extracted_text.slice(0, 5000), "```", ``, `</details>`, ``);
    }
  }
  return new Response(parts.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="radar-export-${new Date().toISOString().slice(0, 10)}.md"`,
    },
  });
});

exportRoute.post("/originals-to-r2", async (c) => {
  const result = await backupResearchOriginals(c.env);
  return c.json(result, result.ok ? 200 : 409);
});

exportRoute.get("/r2-list", async (c) => {
  const listed = await c.env.EXPORTS.list({ prefix: "exports/" });
  return c.json({ keys: listed.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })) });
});

exportRoute.get("/r2/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.EXPORTS.get(key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename="${key.split("/").pop()}"`,
    },
  });
});

export default exportRoute;
