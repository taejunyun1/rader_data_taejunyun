export type IngestChannel = "MANUAL" | "OBSIDIAN" | "DISCOVERY" | "HOMEPAGE";

export type InputFormat =
  | "PLAIN_TEXT"
  | "MARKDOWN"
  | "OBSIDIAN_MARKDOWN"
  | "URL_HTML"
  | "PDF_TEXT"
  | "PDF_SCAN"
  | "HOMEPAGE_JSON"
  | "DISCOVERY_LINK";

export type QualityStatus = "UNREVIEWED" | "READY" | "REVIEW" | "EMPTY" | "FAILED";
export type VersionOrigin = "INITIAL_INGEST" | "OBSIDIAN_SYNC" | "REEXTRACT" | "RENORMALIZE" | "MANUAL_EDIT";
export type VersionReviewStatus = "ACTIVE" | "PENDING_REVIEW" | "SUPERSEDED" | "REJECTED";

export interface NormalizationReport {
  extractedChars: number;
  normalizedChars: number;
  meaningfulChars: number;
  replacementCharCount: number;
  repeatedLineRatio: number;
  unresolvedEmbedCount: number;
  pageCount: number | null;
  textPages: number | null;
  warnings: string[];
}

export interface NormalizationResult {
  normalizedText: string;
  report: NormalizationReport;
  qualityStatus: QualityStatus;
  metadata: Record<string, unknown>;
}

export interface IngestMeta {
  channel: IngestChannel;
  format: InputFormat;
}

export function normalizeIngestText(text: string, format: InputFormat): NormalizationResult {
  const extracted = normalizeUnicode(text);
  const metadata: Record<string, unknown> = {};
  let body = extracted;
  let unresolvedEmbedCount = 0;
  const warnings: string[] = [];

  if (format === "MARKDOWN" || format === "OBSIDIAN_MARKDOWN") {
    const frontmatter = extractFrontmatter(body);
    body = frontmatter.body;
    Object.assign(metadata, frontmatter.metadata);
    if (format === "OBSIDIAN_MARKDOWN") {
      body = body.replace(/```(dataview|dataviewjs|templater)[\s\S]*?```/gi, (_block, kind: string) => {
        warnings.push(`dynamic_block:${kind.toLowerCase()}`);
        return `[실행 블록 제외: ${kind.toLowerCase()}]`;
      });
      body = body.replace(/!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, file: string, label?: string) => {
        unresolvedEmbedCount += 1;
        return `[첨부: ${(label ?? file).trim()}]`;
      });
      body = body.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => (label ?? target).trim());
      body = body.replace(/^>\s*\[!([^\]]+)\]\s*/gm, "> $1: ");
      body = body.replace(/<!--[\s\S]*?-->/g, "");
    }
  }

  if (format === "PDF_TEXT" || format === "PDF_SCAN") {
    body = body.replace(/(\p{L})-\n(?=\p{L})/gu, "$1");
  }

  const normalizedText = normalizeUnicode(body)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = normalizedText.split("\n").map((line) => line.trim()).filter(Boolean);
  const repeatedLineRatio = calculateRepeatedLineRatio(lines);
  const replacementCharCount = (extracted.match(/\uFFFD/g) ?? []).length;
  const meaningfulChars = countMeaningfulCharacters(normalizedText);
  const pageNumbers = [...normalizedText.matchAll(/\[page\s+(\d+)\]/gi)].map((match) => Number(match[1]));
  const pageCount = pageNumbers.length ? Math.max(...pageNumbers) : null;
  const textPages = pageNumbers.length || null;

  if (replacementCharCount > 0) warnings.push("replacement_character");
  if (repeatedLineRatio > 0.35) warnings.push("repeated_lines");
  if (unresolvedEmbedCount > 0) warnings.push("unresolved_embed");
  if (!meaningfulChars) warnings.push("empty_text");

  const report: NormalizationReport = {
    extractedChars: countMeaningfulCharacters(extracted),
    normalizedChars: normalizedText.length,
    meaningfulChars,
    replacementCharCount,
    repeatedLineRatio,
    unresolvedEmbedCount,
    pageCount,
    textPages,
    warnings: [...new Set(warnings)],
  };

  const minimum = format === "PLAIN_TEXT" || format === "MARKDOWN" || format === "OBSIDIAN_MARKDOWN" ? 40 : 200;
  const qualityStatus: QualityStatus = !meaningfulChars
    ? "EMPTY"
    : format === "PDF_SCAN"
      ? "REVIEW"
      : meaningfulChars < minimum || report.warnings.length > 0
        ? "REVIEW"
        : "READY";

  return { normalizedText, report, qualityStatus, metadata };
}

export function deriveIngestMeta(origin: string | null | undefined, filename?: string, metadata?: Record<string, unknown>): IngestMeta {
  const source = origin ?? "manual";
  if (source.startsWith("obsidian:")) return { channel: "OBSIDIAN", format: "OBSIDIAN_MARKDOWN" };
  if (source.startsWith("discovery:")) return { channel: "DISCOVERY", format: "DISCOVERY_LINK" };
  if (source.startsWith("homepage")) return { channel: "HOMEPAGE", format: "HOMEPAGE_JSON" };
  if (source === "url") return { channel: "MANUAL", format: "URL_HTML" };
  if (source === "upload:pdf") return { channel: "MANUAL", format: metadata?.scannedPdf ? "PDF_SCAN" : "PDF_TEXT" };
  if (source === "upload:md" || /\.(md|markdown)$/i.test(filename ?? "")) return { channel: "MANUAL", format: "MARKDOWN" };
  return { channel: "MANUAL", format: "PLAIN_TEXT" };
}

function normalizeUnicode(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function extractFrontmatter(value: string): { body: string; metadata: Record<string, unknown> } {
  if (!value.startsWith("---\n")) return { body: value, metadata: {} };
  const end = value.indexOf("\n---", 4);
  if (end < 0) return { body: value, metadata: {} };
  const raw = value.slice(4, end);
  const metadata: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([^:#]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!.trim();
    const valueText = match[2]!.trim();
    metadata[key] = valueText.replace(/^['"]|['"]$/g, "");
  }
  return { body: value.slice(end + "\n---".length).replace(/^\n+/, ""), metadata };
}

function countMeaningfulCharacters(value: string): number {
  return [...value.replace(/\[[^\]]*\]/g, "").matchAll(/[\p{L}\p{N}]/gu)].length;
}

function calculateRepeatedLineRatio(lines: string[]): number {
  if (lines.length < 3) return 0;
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const repeated = [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
  return repeated / lines.length;
}
