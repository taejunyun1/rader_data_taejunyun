import { normalizeDoi, normalizeOriginIdentity, normalizeUrl } from "./normalize";

export type DuplicateDecision = "AUTO_MERGE" | "REVIEW" | "SEPARATE";

export type DuplicateReason =
  | "DOI_EXACT"
  | "DOI_CONFLICT"
  | "CANONICAL_URL_EXACT"
  | "RAW_HASH_EXACT"
  | "NORMALIZED_TEXT_HASH_EXACT"
  | "OBSIDIAN_ORIGIN_EXACT"
  | "TITLE_EXACT"
  | "TITLE_EXACT_WITHOUT_SUPPORT"
  | "TITLE_SIMILAR_HIGH"
  | "TITLE_SIMILAR_REVIEW"
  | "TITLE_DISSIMILAR"
  | "FIRST_AUTHOR_EXACT"
  | "YEAR_EXACT"
  | "CANONICAL_HOST_EXACT"
  | "NO_MATCHING_SIGNAL";

export interface SourceMatchInput {
  doi?: string | null;
  canonicalUrl?: string | null;
  rawContentHash?: string | null;
  normalizedTextHash?: string | null;
  origin?: string | null;
  title?: string | null;
  authors?: string | null;
  year?: number | null;
}

export interface DuplicateAssessment {
  decision: DuplicateDecision;
  confidence: number;
  reasons: DuplicateReason[];
  titleSimilarity: number | null;
}

function present(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizedDoi(value?: string | null): string | null {
  const normalized = value ? normalizeDoi(value) : "";
  return normalized || null;
}

function normalizedTitle(value?: string | null): string | null {
  const normalized = value
    ?.normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || null;
}

function normalizedFirstAuthor(value?: string | null): string | null {
  const author = value?.split(/[,;]/, 1)[0];
  if (!author) return null;
  return normalizedTitle(author);
}

function canonicalHost(value?: string | null): string | null {
  const normalized = value ? normalizeUrl(value) : null;
  if (!normalized) return null;
  return new URL(normalized).hostname;
}

function bigrams(value: string): Map<string, number> {
  const result = new Map<string, number>();
  if (value.length < 2) {
    result.set(value, 1);
    return result;
  }
  for (let index = 0; index < value.length - 1; index += 1) {
    const bigram = value.slice(index, index + 2);
    result.set(bigram, (result.get(bigram) ?? 0) + 1);
  }
  return result;
}

function diceSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  let overlap = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (const count of leftBigrams.values()) leftCount += count;
  for (const count of rightBigrams.values()) rightCount += count;
  for (const [bigram, count] of leftBigrams) {
    overlap += Math.min(count, rightBigrams.get(bigram) ?? 0);
  }
  return (2 * overlap) / (leftCount + rightCount);
}

function assessment(
  decision: DuplicateDecision,
  confidence: number,
  reasons: DuplicateReason[],
  titleSimilarity: number | null = null,
): DuplicateAssessment {
  return { decision, confidence, reasons, titleSimilarity };
}

export function evaluateDuplicate(left: SourceMatchInput, right: SourceMatchInput): DuplicateAssessment {
  const leftRawHash = present(left.rawContentHash);
  const rightRawHash = present(right.rawContentHash);
  if (leftRawHash && leftRawHash === rightRawHash) {
    return assessment("AUTO_MERGE", 1, ["RAW_HASH_EXACT"]);
  }

  const leftTextHash = present(left.normalizedTextHash);
  const rightTextHash = present(right.normalizedTextHash);
  if (leftTextHash && leftTextHash === rightTextHash) {
    return assessment("AUTO_MERGE", 1, ["NORMALIZED_TEXT_HASH_EXACT"]);
  }

  const leftDoi = normalizedDoi(left.doi);
  const rightDoi = normalizedDoi(right.doi);
  if (leftDoi && rightDoi && leftDoi !== rightDoi) {
    return assessment("SEPARATE", 1, ["DOI_CONFLICT"]);
  }
  if (leftDoi && leftDoi === rightDoi) {
    return assessment("AUTO_MERGE", 1, ["DOI_EXACT"]);
  }

  const leftUrl = left.canonicalUrl ? normalizeUrl(left.canonicalUrl) : null;
  const rightUrl = right.canonicalUrl ? normalizeUrl(right.canonicalUrl) : null;
  if (leftUrl && leftUrl === rightUrl) {
    return assessment("AUTO_MERGE", 1, ["CANONICAL_URL_EXACT"]);
  }

  const leftOrigin = left.origin ? normalizeOriginIdentity(left.origin) : null;
  const rightOrigin = right.origin ? normalizeOriginIdentity(right.origin) : null;
  if (leftOrigin && leftOrigin === rightOrigin) {
    return assessment("AUTO_MERGE", 1, ["OBSIDIAN_ORIGIN_EXACT"]);
  }

  const leftTitle = normalizedTitle(left.title);
  const rightTitle = normalizedTitle(right.title);
  if (!leftTitle || !rightTitle) {
    return assessment("SEPARATE", 0, ["NO_MATCHING_SIGNAL"]);
  }

  const titleSimilarity = diceSimilarity(leftTitle, rightTitle);
  const support: DuplicateReason[] = [];
  const leftAuthor = normalizedFirstAuthor(left.authors);
  const rightAuthor = normalizedFirstAuthor(right.authors);
  if (leftAuthor && leftAuthor === rightAuthor) support.push("FIRST_AUTHOR_EXACT");
  if (left.year != null && left.year === right.year) support.push("YEAR_EXACT");
  const leftHost = canonicalHost(left.canonicalUrl);
  const rightHost = canonicalHost(right.canonicalUrl);
  if (leftHost && leftHost === rightHost) support.push("CANONICAL_HOST_EXACT");

  if (titleSimilarity >= 0.96 && support.length > 0) {
    const titleReason = titleSimilarity === 1 ? "TITLE_EXACT" : "TITLE_SIMILAR_HIGH";
    return assessment("AUTO_MERGE", titleSimilarity, [titleReason, ...support], titleSimilarity);
  }
  if (titleSimilarity === 1) {
    return assessment("REVIEW", titleSimilarity, ["TITLE_EXACT_WITHOUT_SUPPORT"], titleSimilarity);
  }
  if (titleSimilarity >= 0.85) {
    return assessment("REVIEW", titleSimilarity, ["TITLE_SIMILAR_REVIEW"], titleSimilarity);
  }
  return assessment("SEPARATE", 1 - titleSimilarity, ["TITLE_DISSIMILAR"], titleSimilarity);
}
