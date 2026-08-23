export interface ExtractedPage {
  html: string;
  title: string;
  text: string;
  siteName: string | null;
  description: string | null;
  finalUrl: string;
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
  const title =
    matchTag(html, "title") ??
    matchMeta(html, "og:title") ??
    decodeEntities(url).trim();
  const description = matchMeta(html, "og:description") ?? matchMeta(html, "description");
  const siteName = matchMeta(html, "og:site_name");
  const text = htmlToText(html).slice(0, 300_000);

  return { html, title: title.slice(0, 300), text, siteName, description, finalUrl };
}

function matchTag(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m?.[1] ? decodeEntities(m[1]).trim() : null;
}

function matchMeta(html: string, prop: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]).trim();
  }
  return null;
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(?:nav|footer|header|aside|noscript)[\s\S]*?<\/(?:nav|footer|header|aside|noscript)>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/(?:&#0?39;|&apos;|&#x27;)/gi, "'");
}
