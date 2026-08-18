const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "ref",
];

export function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    let s = u.toString();
    if (s.endsWith("?")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

export function normalizeDoi(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  d = d.replace(/^doi:\s*/, "");
  return d;
}

export function titleNorm(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

export function firstAuthor(authors?: string | null): string | null {
  if (!authors) return null;
  const a = authors.split(/[,;]/)[0]?.trim();
  return a ? a.toLowerCase() : null;
}
