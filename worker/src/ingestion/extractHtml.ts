import { classifyTextScope, normalizeIngestText, type TextScope } from "@radar/shared/ingestion";

const CONTENT_HINT_RE = /\b(article|content|post|entry|story|main|body|read|markdown|page)\b/i;
const DROP_BLOCK_RE = /<(script|style|nav|footer|header|aside|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ROOT_SHELL_RE = /<(div|main|section)\b[^>]*(?:id|class)=["'][^"']*(root|app|__next|sapper|gatsby|mount)[^"']*["'][^>]*>\s*<\/\1>/i;
const NOISE_ATTR_TOKEN = String.raw`cookie|consent|gdpr|privacy|share|social|subscribe|newsletter|promo|sponsor|advert(?:isement|ising)?|ad[-_ ](?:slot|banner|container|wrapper)|outbrain|taboola`;
const NOISE_BLOCK_RE = new RegExp(
  `<([a-z0-9:-]+)\\b(?=[^>]*\\b(?:class|id|aria-label|aria-labelledby|data-testid|data-component|data-slot|role)=["'][^"']*(?:${NOISE_ATTR_TOKEN})[^"']*["'])[^>]*>[\\s\\S]*?<\\/\\1>`,
  "gi",
);

export interface HtmlExtractionResult {
  title: string;
  description: string | null;
  siteName: string | null;
  text: string;
  selectedFragmentHtml: string | null;
  warnings: string[];
  scope: TextScope;
  method: "HTML_STATIC";
}

export function extractStaticHtml(html: string, url: string): HtmlExtractionResult {
  const source = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  const sanitized = stripBoilerplate(source);
  const title = firstNonEmpty(
    extractTagText(source, "title"),
    extractMetaContent(source, "og:title"),
    extractMetaContent(source, "twitter:title"),
    decodeHtmlEntities(url).trim(),
  ) ?? decodeHtmlEntities(url).trim();
  const description = firstNonEmpty(extractMetaContent(source, "og:description"), extractMetaContent(source, "description"));
  const siteName = firstNonEmpty(extractMetaContent(source, "og:site_name"), extractMetaContent(source, "application-name"));

  const candidates = collectCandidates(sanitized);
  const best = candidates[0] ?? null;
  const bodyHtml = extractTagFragment(source, "body") ?? sanitized;
  const bodyText = fragmentToText(bodyHtml);
  const useBodyFallback = !best || best.meaningfulChars < 200;
  const selectedText = useBodyFallback ? bodyText : best.text;

  const warnings = new Set<string>();
  if (useBodyFallback) warnings.add("fallback_body");
  if (looksLikeJsShell(source, bodyText)) warnings.add("js_shell");

  const normalized = normalizeIngestText(selectedText, "URL_HTML");
  for (const warning of normalized.report.warnings) warnings.add(warning);

  const scope = classifyTextScope({
    format: "URL_HTML",
    meaningfulChars: normalized.report.meaningfulChars,
    warnings: [...warnings],
    extractionMethod: "HTML_STATIC",
  }).scope;

  return {
    title: title.slice(0, 300),
    description,
    siteName,
    text: normalized.normalizedText.slice(0, 300_000),
    selectedFragmentHtml: best?.html ?? null,
    warnings: [...warnings],
    scope,
    method: "HTML_STATIC",
  };
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/(?:&#0?39;|&apos;|&#x27;)/gi, "'");
}

function collectCandidates(html: string): Candidate[] {
  const candidates = new Map<string, Candidate>();

  for (const fragment of collectTagFragments(html, "article")) addCandidate(candidates, fragment);
  for (const fragment of collectTagFragments(html, "main")) addCandidate(candidates, fragment);
  for (const fragment of collectRoleMainFragments(html)) addCandidate(candidates, fragment);
  for (const fragment of collectContentHintFragments(html)) addCandidate(candidates, fragment);

  return [...candidates.values()].sort((left, right) => right.score - left.score);
}

function addCandidate(target: Map<string, Candidate>, html: string): void {
  const text = fragmentToText(html);
  const meaningfulChars = countMeaningfulCharacters(text);
  if (!meaningfulChars) return;

  const paragraphCount = countParagraphs(text);
  const linkDensity = calculateLinkDensity(html, meaningfulChars);
  const repeatedLineRatio = calculateRepeatedLineRatio(text);
  const score = meaningfulChars + paragraphCount * 40 - linkDensity * meaningfulChars * 0.8 - repeatedLineRatio * meaningfulChars;
  const key = text.slice(0, 500);
  const previous = target.get(key);

  if (!previous || previous.score < score) {
    target.set(key, { html, text, meaningfulChars, score });
  }
}

function stripBoilerplate(html: string): string {
  let cleaned = html.replace(DROP_BLOCK_RE, " ");
  let previous = "";

  while (cleaned !== previous) {
    previous = cleaned;
    cleaned = cleaned.replace(NOISE_BLOCK_RE, " ");
  }

  return cleaned;
}

function collectTagFragments(html: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

function collectRoleMainFragments(html: string): string[] {
  const pattern = /<([a-z0-9:-]+)\b[^>]*\brole=["']main["'][^>]*>[\s\S]*?<\/\1>/gi;
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

function collectContentHintFragments(html: string): string[] {
  const pattern = /<([a-z0-9:-]+)\b([^>]*)>[\s\S]*?<\/\1>/gi;
  const results: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const attrs = match[2] ?? "";
    if (!/(?:class|id)=["'][^"']+["']/i.test(attrs)) continue;
    if (!CONTENT_HINT_RE.test(attrs)) continue;
    results.push(match[0]);
  }
  return results;
}

function extractTagFragment(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[0] ?? null;
}

function extractTagText(html: string, tag: string): string | null {
  const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ? decodeHtmlEntities(stripTags(match[1])).trim() : null;
}

function extractMetaContent(html: string, prop: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1]).trim();
  }
  return null;
}

function fragmentToText(html: string): string {
  return decodeHtmlEntities(
    stripBoilerplate(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|section|article|main)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function countMeaningfulCharacters(value: string): number {
  return [...value.replace(/\[[^\]]*\]/g, "").matchAll(/[\p{L}\p{N}]/gu)].length;
}

function countParagraphs(value: string): number {
  return value.split(/\n+/).map((line) => line.trim()).filter(Boolean).length;
}

function calculateLinkDensity(html: string, meaningfulChars: number): number {
  if (!meaningfulChars) return 0;
  const linkText = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => fragmentToText(match[1] ?? ""))
    .join(" ");
  return Math.min(1, countMeaningfulCharacters(linkText) / meaningfulChars);
}

function calculateRepeatedLineRatio(value: string): number {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return 0;
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  return repeated / lines.length;
}

function looksLikeJsShell(html: string, bodyText: string): boolean {
  const meaningfulChars = countMeaningfulCharacters(bodyText);
  return meaningfulChars < 200 && /<script\b/i.test(html) && ROOT_SHELL_RE.test(html);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim()) return value.trim();
  }
  return null;
}

interface Candidate {
  html: string;
  text: string;
  meaningfulChars: number;
  score: number;
}
