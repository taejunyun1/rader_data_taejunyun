import { searchWorks, type OpenAlexWork } from "../lib/openalex";

export interface QueueImportResult {
  sourceId: string | null;
  title: string;
  status: "imported" | "duplicate" | "failed";
  detail?: string;
}

export async function importQueuedItem(env: Env, item: { title: string; author: string | null; openalexId: string | null }): Promise<QueueImportResult> {
  const { createSource } = await import("../ingestion/store");
  const { analyzeSource } = await import("../analysis/analyze");

  let abstract: string | null = null;
  let year: number | null = null;
  let authors: string | undefined = item.author ?? undefined;
  let doi: string | undefined;
  let oaUrl: string | null = null;
  let canonicalUrl: string | undefined;

  if (item.openalexId) {
    canonicalUrl = item.openalexId;
    try {
      const works = await searchWorks(item.title, 3);
      const match: OpenAlexWork | undefined = works.find((w) => w.id === item.openalexId) ?? works[0];
      if (match) {
        abstract = (await fetchWorkAbstract(match.id)) ?? null;
        year = match.year;
        if (!authors && match.authors) authors = match.authors;
        doi = match.doi?.replace("https://doi.org/", "") ?? undefined;
        oaUrl = match.openAccessUrl ?? null;
      }
    } catch {
      /* metadata optional */
    }
  }

  const text = [item.title, authors ? `저자: ${authors}` : "", year ? `출판: ${year}` : "", abstract ? `\n초록:\n${abstract}` : ""]
    .filter(Boolean)
    .join("\n");

  try {
    const r = await createSource(env, {
      kind: "PAPER_ACADEMIC",
      title: item.title,
      authors,
      year: year ?? undefined,
      canonicalUrl,
      doi,
      origin: "reading-queue",
      original: text || item.title,
      extractedText: text || undefined,
      metadata: { oaUrl, fromQueue: true },
    });
    if (!r.duplicateOf) {
      await analyzeSource(env, r.sourceId).catch(() => undefined);
      return { sourceId: r.sourceId, title: item.title, status: "imported" };
    }
    return { sourceId: r.sourceId, title: item.title, status: "duplicate" };
  } catch (e) {
    return { sourceId: null, title: item.title, status: "failed", detail: (e as Error).message.slice(0, 150) };
  }
}

async function fetchWorkAbstract(openalexId: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(`${openalexId}?select=abstract_inverted_index&mailto=taejun.foto@gmail.com`, { signal: ac.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { abstract_inverted_index?: Record<string, number[]> };
    if (!data.abstract_inverted_index) return null;
    const positions: { word: string; pos: number }[] = [];
    for (const [word, idxs] of Object.entries(data.abstract_inverted_index)) {
      for (const i of idxs) positions.push({ word, pos: i });
    }
    positions.sort((a, b) => a.pos - b.pos);
    return positions.map((p) => p.word).join(" ").slice(0, 4000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
