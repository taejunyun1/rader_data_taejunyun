export interface ArxivWork {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  url: string;
  abstract: string | null;
  categories: string[];
}

export async function searchArxiv(query: string, limit = 3): Promise<ArxivWork[]> {
  const params = new URLSearchParams({
    search_query: `all:${query} AND (cat:cs.CV OR cat:cs.HC OR cat:cs.MM OR cat:eess.IV OR cat:physics.optics)`,
    start: "0",
    max_results: String(limit),
    sortBy: "relevance",
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(`https://export.arxiv.org/api/query?${params}`, {
      headers: { "User-Agent": "ResearchRadar/1.0 (personal research tool)" },
      signal: ac.signal,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const entries = xml.split(/<entry>/).slice(1);
    return entries
      .map(parseEntry)
      .filter((w): w is ArxivWork => w !== null)
      .slice(0, limit);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function parseEntry(xml: string): ArxivWork | null {
  const idMatch = xml.match(/<id>(.*?)<\/id>/);
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  if (!idMatch?.[1] || !titleMatch?.[1]) return null;
  const title = decodeXml(titleMatch[1]).replace(/\s+/g, " ").trim();
  const authors = [...xml.matchAll(/<name>(.*?)<\/name>/g)]
    .map((m) => decodeXml(m[1] ?? ""))
    .slice(0, 3)
    .join(", ");
  const yearMatch = xml.match(/<published>(\d{4})/);
  const url = idMatch[1].replace("http://", "https://");
  const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/);
  const categories = [...xml.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]!).filter(Boolean);
  return {
    id: url,
    title,
    authors,
    year: yearMatch ? parseInt(yearMatch[1]!, 10) : null,
    url,
    abstract: summaryMatch ? decodeXml(summaryMatch[1]!).replace(/\s+/g, " ").trim() : null,
    categories,
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
