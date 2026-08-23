import type { DiscoveryProviderResult } from "@radar/shared/discoveryRun";

const OPENALEX_BASE = "https://api.openalex.org/works";

export interface OpenAlexWork {
  id: string;
  title: string;
  authors: string;
  year: number | null;
  abstract: string | null;
  doi: string | null;
  openAccessUrl: string | null;
  citedByCount: number;
}

export async function searchWorks(query: string, limit = 5): Promise<DiscoveryProviderResult<OpenAlexWork>> {
  const startedAt = Date.now();
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    select: "id,display_name,publication_year,doi,open_access,cited_by_count,authorships,abstract_inverted_index",
    mailto: "taejun.foto@gmail.com",
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const res = await fetch(`${OPENALEX_BASE}?${params}`, { signal: ac.signal });
    if (!res.ok) {
      return { status: "HTTP_ERROR", items: [], errorCode: `HTTP_${res.status}`, elapsedMs: Date.now() - startedAt };
    }
    let data: {
      results?: {
        id: string;
        display_name: string;
        publication_year: number | null;
        doi: string | null;
        open_access?: { oa_url?: string | null };
        cited_by_count: number;
        authorships?: { author?: { display_name?: string } }[];
        abstract_inverted_index?: Record<string, number[]> | null;
      }[];
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { status: "PARSE_ERROR", items: [], errorCode: "INVALID_JSON", elapsedMs: Date.now() - startedAt };
    }
    if (!Array.isArray(data.results)) {
      return { status: "PARSE_ERROR", items: [], errorCode: "MISSING_RESULTS", elapsedMs: Date.now() - startedAt };
    }
    const items = data.results.map((r) => ({
      id: r.id,
      title: r.display_name,
      authors: (r.authorships ?? [])
        .slice(0, 3)
        .map((a) => a.author?.display_name ?? "")
        .filter(Boolean)
        .join(", "),
      year: r.publication_year,
      abstract: invertedIndexToText(r.abstract_inverted_index),
      doi: r.doi,
      openAccessUrl: r.open_access?.oa_url ?? null,
      citedByCount: r.cited_by_count,
    }));
    return { status: "OK", items, errorCode: null, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return {
      status: isTimeout ? "TIMEOUT" : "HTTP_ERROR",
      items: [],
      errorCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function invertedIndexToText(index?: Record<string, number[]> | null): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  const text = words.filter(Boolean).join(" ").trim();
  return text || null;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9가-힣\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleSimilarity(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (shorter.length >= 8 && longer.includes(shorter)) return true;
  const wa = new Set(na.split(" "));
  const wb = new Set(nb.split(" "));
  const overlap = [...wa].filter((w) => wb.has(w) && w.length > 3).length;
  const denom = Math.min(wa.size, wb.size) || 1;
  return overlap / denom >= 0.6;
}

export async function verifyWork(title: string, author?: string | null): Promise<OpenAlexWork | null> {
  const queries = [author ? `${title} ${author}` : title, title];
  for (const q of queries) {
    const results = await searchWorks(q, 5);
    for (const r of results.items) {
      if (titleSimilarity(title, r.title)) {
        if (author && r.authors) {
          const authorSurname = author.split(/\s+/)[0]?.toLowerCase() ?? "";
          if (authorSurname && !r.authors.toLowerCase().includes(authorSurname)) continue;
        }
        return r;
      }
    }
  }
  return null;
}
