import { cleanDiscoverySourceText } from "@radar/shared/discovery";

const DATE_SLUG_PREFIX = /^\d{4}-\d{2}-\d{2}[-_]+/;

export function formatSourceTitle(value: unknown, fallback = "제목 없음"): string {
  const cleaned = cleanDiscoverySourceText(String(value ?? "")).trim();
  if (!cleaned) return fallback;

  const withoutDatePrefix = cleaned.replace(DATE_SLUG_PREFIX, "");
  const looksLikeSlug = !/\s/.test(withoutDatePrefix) && /[-_]/.test(withoutDatePrefix);
  const readable = looksLikeSlug
    ? withoutDatePrefix.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    : withoutDatePrefix;

  return readable || fallback;
}
