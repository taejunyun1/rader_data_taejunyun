import type { TextScope } from "@radar/shared/ingestion";
import { extractStaticHtml } from "./extractHtml";

export interface ExtractedPage {
  html: string;
  title: string;
  text: string;
  siteName: string | null;
  description: string | null;
  finalUrl: string;
  warnings: string[];
  scope: TextScope;
  method: "HTML_STATIC";
}

export async function fetchAndExtract(url: string): Promise<ExtractedPage> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": "ResearchRadar/0.1 (personal research tool)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      redirect: "follow",
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`fetch_failed_${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|xhtml/i.test(ct)) {
    throw new Error(`unsupported_content_type:${ct.split(";")[0] ?? "unknown"}`);
  }

  const raw = await res.text();
  const html = raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw;
  const finalUrl = res.url || url;
  const extracted = extractStaticHtml(html, finalUrl);

  return {
    html,
    title: extracted.title,
    text: extracted.text,
    siteName: extracted.siteName,
    description: extracted.description,
    finalUrl,
    warnings: extracted.warnings,
    scope: extracted.scope,
    method: extracted.method,
  };
}
