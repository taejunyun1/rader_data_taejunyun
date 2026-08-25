export type DiscoveryProvider = "openalex" | "arxiv" | "rss" | "riss" | "unknown";

export type DiscoveryLane = "ORIGINAL" | "COUNTER";
export type DiscoveryQuerySource = "SAVED" | "RECOMMENDED" | "MOMENTUM" | "FEED";

export interface DiscoveryLaneProfile {
  keywords: string[];
  strength: number;
}

export interface DiscoveryProfile {
  original: DiscoveryLaneProfile;
  counter: DiscoveryLaneProfile;
  updatedAt: string;
}

export type DiscoveryRecommendationSource =
  | "SAVED"
  | "MOMENTUM"
  | "DISTILL"
  | "RESEARCH_GAP"
  | "COUNTER"
  | "UNDERREPRESENTED";

export interface DiscoveryKeywordRecommendation {
  keyword: string;
  lane: DiscoveryLane;
  source: DiscoveryRecommendationSource;
  reason: string;
  score: number;
  selected: boolean;
}

export type ResearchJobKind =
  | "DISCOVERY_RUN"
  | "DISTILL_RUN"
  | "RADAR_SYNTHESIS"
  | "DEEP_ANALYSIS"
  | "SOURCE_ACQUISITION"
  | "VISUAL_TRANSFORM"
  | "VISUAL_ANALYSIS"
  | "VISUAL_EXTRACTION";

export type ResearchJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED";

export type DiscoveryAcquisitionStatus = "QUEUED" | "LINK_ONLY";

export interface DiscoveryKeepResponse {
  ok: true;
  status: "KEPT";
  sourceId: string;
  jobId?: string;
  acquisitionStatus?: DiscoveryAcquisitionStatus;
}

export type ResearchJobResultRef =
  | { view: "DISCOVER" }
  | { view: "DISTILL"; sessionId: string }
  | { view: "RADAR"; period: "WEEKLY" | "MONTHLY" | "YEARLY"; snapshotId?: string }
  | { view: "RESERVOIR"; sourceId: string; analysisId: string }
  | { view: "RESERVOIR"; sourceId: string; acquisition: true }
  | { view: "VISUAL"; visualAssetId: string; sourceId?: string; extractionRunId?: string };

export interface ResearchJob {
  id: string;
  workflowInstanceId: string | null;
  kind: ResearchJobKind;
  status: ResearchJobStatus;
  progress: number;
  message: string | null;
  input: unknown;
  result: unknown;
  resultRef: ResearchJobResultRef | null;
  errorCode: string | null;
  error: string | null;
  retryOf: string | null;
  requestedBy: string | null;
  dedupeKey: string;
  dismissedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export type DiscoveryAccessStatus = "FREE_FULLTEXT" | "PDF" | "INSTITUTION" | "PAYWALLED" | "UNKNOWN";

export interface DiscoveryAssessmentInput {
  provider: DiscoveryProvider | string;
  title: string;
  summary?: string | null;
  year?: number | null;
  categories?: string[];
  accessStatus?: DiscoveryAccessStatus;
}

export type DiscoveryDecisionReason =
  | "RELEVANT"
  | "NO_RESEARCH_ANCHOR"
  | "BLOCKED_DOMAIN"
  | "ENGINEERING_ONLY"
  | "LOW_SCORE"
  | "PAYWALLED"
  | "ACCESS_UNKNOWN";

export interface DiscoveryAssessment {
  accepted: boolean;
  score: number;
  matchedTerms: string[];
  reason: DiscoveryDecisionReason;
}

export const DISCOVERY_MIN_SCORE = 0.65;

const CORE_RESEARCH_TERMS = [
  "photography",
  "photographic",
  "computational photography",
  "visual culture",
  "visuality",
  "image theory",
  "image politics",
  "feminist photography",
  "materiality",
  "tactility",
  "print labor",
  "machine vision",
  "computer vision",
  "digital labor",
  "data epistemology",
  "network culture",
  "media art",
  "digital artwork",
  "contemporary art",
];

const CRITICAL_CONTEXT_TERMS = [
  "visual culture",
  "visuality",
  "image theory",
  "image politics",
  "feminist",
  "feminism",
  "materiality",
  "tactility",
  "print labor",
  "digital labor",
  "data epistemology",
  "network culture",
  "media art",
  "digital artwork",
  "contemporary art",
  "authorship",
  "embodied",
  "provenance",
  "gender",
];

const TECHNICAL_TOPIC_TERMS = [
  "algorithm",
  "algorithmic",
  "artificial intelligence",
  "ai",
  "machine",
  "digital",
  "data",
  "infrastructure",
  "labor",
  "surveillance",
  "network",
  "benchmark",
  "dataset",
  "transformer",
  "localization",
  "calibration",
  "metrology",
  "recognition",
  "segmentation",
  "classification",
  "retrieval",
  "optimization",
  "accuracy",
  "pipeline",
  "system evaluation",
];

const ENGINEERING_ONLY_TERMS = [
  "image processing",
  "calibration",
  "metrology",
  "benchmark",
  "dataset",
  "geolocating",
  "geolocation",
  "localization",
  "recognition",
  "segmentation",
  "classification",
  "retrieval",
  "transformer",
  "pipeline",
  "automated",
  "accuracy",
  "optical",
  "sensor",
  "robotics",
  "reconstruction",
  "compression",
  "detection",
  "enhancement",
  "system evaluation",
];

const BLOCKED_WITHOUT_ANCHOR = [
  "quantum field",
  "string theory",
  "planetary theory",
  "hamiltonian planetary",
  "particle physics",
  "quantum gravity",
  "astrophysics",
  "cosmology",
];

const GENERIC_QUERY_SEEDS = new Set(["data", "theory", "ai", "image", "visual", "art", "technology", "research"]);

function decodeEntityText(value: string): string {
  return value
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/i, "").replace(/\]\]>$/i, "").trim();
}

export function normalizeDiscoveryTitle(value: string): string {
  return stripCdata(decodeEntityText(value))
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanDiscoverySourceText(value: string): string {
  return stripCdata(decodeEntityText(value))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return stripCdata(decodeEntityText(value)).toLowerCase().replace(/[“”‘’]/g, "'").replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isUsableDiscoveryQuery(query: string): boolean {
  const normalized = normalizeDiscoveryTitle(query);
  return Boolean(normalized) && !GENERIC_QUERY_SEEDS.has(normalized);
}

export function normalizeDiscoveryKeywords(value: unknown, max = 4): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const keyword = item.trim().replace(/\s+/g, " ");
    const key = normalizeDiscoveryTitle(keyword);
    const looksLikeSentence = keyword.length > 18 && /[.!?]|(했다|않았다|있다|없다|않음|필요함|드러낸다)["'」”]?$/u.test(keyword);
    if (!keyword || keyword.length > 80 || looksLikeSentence || !isUsableDiscoveryQuery(keyword) || seen.has(key)) continue;
    seen.add(key);
    result.push(keyword.slice(0, 120));
    if (result.length >= max) break;
  }
  return result;
}

/**
 * Turns a user's Korean/mixed research phrase into a provider-friendly query
 * while keeping the original phrase intact in provenance and the UI.
 */
export function discoveryProviderQuery(value: string): string {
  const query = stripCdata(decodeEntityText(value)).replace(/\s+/g, " ").trim();
  const lower = query.toLowerCase();
  const concepts: string[] = [];
  if (/\bai\b|인공지능|알고리즘|머신비전|machine vision|computer vision/i.test(lower)) concepts.push("AI algorithm visual culture");
  if (/네트워크|network|플랫폼|platform/i.test(lower)) concepts.push("network culture image theory");
  if (/데이터|\bdata\b/i.test(lower)) concepts.push("data epistemology photography");
  if (/사진|photograph|이미지|image|시각|visual/i.test(lower)) concepts.push("photography visual culture");
  if (/물질|material|촉각|tactil/i.test(lower)) concepts.push("materiality tactility photography");
  if (/재현|representation|저자|authorship|저작권|copyright/i.test(lower)) concepts.push("photography representation authorship");
  if (concepts.length > 0) return [...new Set(concepts.join(" ").split(" "))].join(" ");
  if (query.length > 80 || /[.!?]|(했다|않았다|있다|없다|않음|필요함)["'」”]?$/u.test(query)) return "photography visual culture";
  return query.replace(/[\/·•]+/g, " ").replace(/[–—]+/g, "-").replace(/\s+/g, " ").trim();
}

export function normalizeDiscoveryProfile(value: unknown, updatedAt = new Date().toISOString()): DiscoveryProfile {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const lane = (key: "original" | "counter", defaultStrength: number): DiscoveryLaneProfile => {
    const rawLane = raw[key] && typeof raw[key] === "object" ? raw[key] as Record<string, unknown> : {};
    const parsedStrength = typeof rawLane.strength === "number" ? rawLane.strength : Number(rawLane.strength);
    return {
      keywords: normalizeDiscoveryKeywords(rawLane.keywords),
      strength: Number.isFinite(parsedStrength) ? Math.max(0, Math.min(100, Math.round(parsedStrength))) : defaultStrength,
    };
  };
  return { original: lane("original", 70), counter: lane("counter", 30), updatedAt };
}

export function strengthQueryLimit(strength: number): number {
  if (strength <= 0) return 0;
  if (strength < 40) return 1;
  if (strength < 70) return 2;
  return 4;
}

export function strengthFetchLimit(strength: number): number {
  if (strength <= 0) return 0;
  if (strength < 40) return 2;
  if (strength < 70) return 4;
  return 6;
}

export function allocateDiscoveryLaneQuotas(originalStrength: number, counterStrength: number, total = 8): Record<DiscoveryLane, number> {
  const original = Math.max(0, Math.min(100, originalStrength));
  const counter = Math.max(0, Math.min(100, counterStrength));
  const sum = original + counter;
  if (total <= 0 || sum <= 0) return { ORIGINAL: 0, COUNTER: 0 };
  if (original <= 0) return { ORIGINAL: 0, COUNTER: total };
  if (counter <= 0) return { ORIGINAL: total, COUNTER: 0 };

  let originalQuota = Math.round(total * original / sum);
  originalQuota = Math.max(1, Math.min(total - 1, originalQuota));
  return { ORIGINAL: originalQuota, COUNTER: total - originalQuota };
}

function matches(text: string, terms: string[]): string[] {
  return terms.filter((term) => {
    if (term === "ai") return /\bai\b/i.test(text);
    return text.includes(term);
  });
}

function recencyScore(year?: number | null): number {
  if (!year) return 0;
  const currentYear = new Date().getFullYear();
  if (year >= currentYear - 5) return 0.1;
  if (year >= currentYear - 12) return 0.05;
  return 0;
}

export function assessDiscoveryCandidate(input: DiscoveryAssessmentInput): DiscoveryAssessment {
  const title = normalize(input.title);
  const summary = normalize(input.summary ?? "");
  const fullText = `${title} ${summary}`.trim();
  const titleCore = matches(title, CORE_RESEARCH_TERMS);
  const summaryCore = matches(summary, CORE_RESEARCH_TERMS);
  const coreMatches = [...new Set([...titleCore, ...summaryCore])];
  const criticalMatches = matches(fullText, CRITICAL_CONTEXT_TERMS);
  const technicalMatches = matches(fullText, TECHNICAL_TOPIC_TERMS);
  const engineeringMatches = matches(fullText, ENGINEERING_ONLY_TERMS);
  const blocked = matches(fullText, BLOCKED_WITHOUT_ANCHOR);
  const matchedTerms = [...new Set([...coreMatches, ...criticalMatches])];
  const hasResearchAnchor = coreMatches.length > 0 || (technicalMatches.length > 0 && criticalMatches.length >= 2);

  if (blocked.length > 0 && coreMatches.length === 0) {
    return { accepted: false, score: 0.1, matchedTerms: blocked, reason: "BLOCKED_DOMAIN" };
  }

  if (engineeringMatches.length > 0 && criticalMatches.length === 0) {
    return { accepted: false, score: 0.2, matchedTerms: engineeringMatches, reason: "ENGINEERING_ONLY" };
  }

  if (!hasResearchAnchor) {
    return { accepted: false, score: 0.15, matchedTerms: [], reason: "NO_RESEARCH_ANCHOR" };
  }

  let score = 0.35;
  if (titleCore.length > 0) score += 0.2;
  if (summaryCore.length > 0) score += 0.15;
  if (criticalMatches.length >= 2) score += 0.1;
  score += recencyScore(input.year);
  if (input.accessStatus === "PDF" || input.accessStatus === "FREE_FULLTEXT") score += 0.1;

  const rounded = Math.min(1, Math.max(0, Number(score.toFixed(2))));
  if (input.accessStatus === "PAYWALLED") return { accepted: false, score: rounded, matchedTerms, reason: "PAYWALLED" };
  if (input.accessStatus === "UNKNOWN" || input.accessStatus === "INSTITUTION" || !input.accessStatus) {
    return { accepted: false, score: rounded, matchedTerms, reason: "ACCESS_UNKNOWN" };
  }
  if (rounded < DISCOVERY_MIN_SCORE) {
    return { accepted: false, score: rounded, matchedTerms, reason: "LOW_SCORE" };
  }
  return { accepted: true, score: rounded, matchedTerms, reason: "RELEVANT" };
}

export function classifyDiscoveryAccess(
  provider: string | null | undefined,
  href: string | null | undefined,
  sourcePolicy?: "FREE_FULLTEXT" | "PAYWALLED" | "INSTITUTION" | "UNKNOWN",
): DiscoveryAccessStatus {
  const normalizedProvider = provider?.toLowerCase() ?? "";
  const normalizedHref = href?.toLowerCase() ?? "";
  if (!href) return "UNKNOWN";
  if (normalizedProvider === "arxiv" || normalizedHref.includes("arxiv.org/abs/") || normalizedHref.includes("arxiv.org/pdf/")) return "PDF";
  if (normalizedHref.endsWith(".pdf")) return "PDF";
  if (sourcePolicy === "FREE_FULLTEXT") return "FREE_FULLTEXT";
  if (sourcePolicy === "PAYWALLED") return "PAYWALLED";
  if (sourcePolicy === "INSTITUTION") return "INSTITUTION";
  if (sourcePolicy === "UNKNOWN") return "UNKNOWN";
  if (normalizedProvider === "riss" || normalizedHref.includes("riss.kr")) return "INSTITUTION";
  if (normalizedHref.includes("artforum.com") || normalizedHref.includes("artnews.com")) return "PAYWALLED";
  if (normalizedHref.includes("hyperallergic.com")) return "FREE_FULLTEXT";
  if (normalizedProvider === "openalex") return "UNKNOWN";
  return "UNKNOWN";
}

export function resolveDiscoveryAccessForExisting(
  stored: DiscoveryAccessStatus | null | undefined,
  provider: string | null | undefined,
  href: string | null | undefined,
  sourcePolicy?: "FREE_FULLTEXT" | "PAYWALLED" | "INSTITUTION" | "UNKNOWN",
): DiscoveryAccessStatus {
  if (stored === "PDF" || stored === "FREE_FULLTEXT") return stored;
  return classifyDiscoveryAccess(provider, href, sourcePolicy);
}

export interface SelectableDiscoveryCandidate {
  externalId: string;
  provider: string;
  sourceId?: string | null;
  title: string;
  score: number;
  keywordOverlap?: number;
}

export interface LaneSelectableDiscoveryCandidate extends SelectableDiscoveryCandidate {
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
}

const DISCOVERY_PROVIDER_QUOTAS: Record<string, number> = {
  openalex: 4,
  arxiv: 2,
  rss: 2,
};

export function selectDiscoveryCandidates<T extends SelectableDiscoveryCandidate>(candidates: T[], divergence = 0): T[] {
  const ranked = [...candidates].sort((a, b) => {
    const scoreA = a.score + divergence * 0.05 * (1 - Math.min(1, Math.max(0, a.keywordOverlap ?? 0)));
    const scoreB = b.score + divergence * 0.05 * (1 - Math.min(1, Math.max(0, b.keywordOverlap ?? 0)));
    return scoreB - scoreA;
  });
  const selected: T[] = [];
  const seenTitles = new Set<string>();
  const providerCounts = new Map<string, number>();

  for (const candidate of ranked) {
    if (selected.length >= 8) break;
    const key = normalizeDiscoveryTitle(candidate.title);
    if (!key || seenTitles.has(key)) continue;
    const count = providerCounts.get(candidate.provider) ?? 0;
    const quota = DISCOVERY_PROVIDER_QUOTAS[candidate.provider] ?? 8;
    if (count >= quota) continue;
    seenTitles.add(key);
    providerCounts.set(candidate.provider, count + 1);
    selected.push(candidate);
  }

  return selected;
}

export function selectDiscoveryCandidatesByLane<T extends LaneSelectableDiscoveryCandidate>(
  candidates: T[],
  originalStrength: number,
  counterStrength: number,
  divergence = 0,
  total = 8,
): T[] {
  const quotas = allocateDiscoveryLaneQuotas(originalStrength, counterStrength, total);
  const ranked = [...candidates].sort((a, b) => {
    const scoreA = a.score + divergence * 0.05 * (1 - Math.min(1, Math.max(0, a.keywordOverlap ?? 0)));
    const scoreB = b.score + divergence * 0.05 * (1 - Math.min(1, Math.max(0, b.keywordOverlap ?? 0)));
    return scoreB - scoreA;
  });
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const seenTitles = new Set<string>();
  const providerCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();

  const canTake = (candidate: T, balancedPass: boolean): boolean => {
    const title = normalizeDiscoveryTitle(candidate.title);
    const providerCount = providerCounts.get(candidate.provider) ?? 0;
    if (selectedIds.has(candidate.externalId) || !title || seenTitles.has(title)) return false;
    if (providerCount >= (DISCOVERY_PROVIDER_QUOTAS[candidate.provider] ?? 8)) return false;
    if (balancedPass && candidate.provider === "rss" && candidate.sourceId) {
      return (sourceCounts.get(candidate.sourceId) ?? 0) === 0;
    }
    return true;
  };

  const remember = (candidate: T): void => {
    const title = normalizeDiscoveryTitle(candidate.title);
    selectedIds.add(candidate.externalId);
    seenTitles.add(title);
    providerCounts.set(candidate.provider, (providerCounts.get(candidate.provider) ?? 0) + 1);
    if (candidate.sourceId) sourceCounts.set(candidate.sourceId, (sourceCounts.get(candidate.sourceId) ?? 0) + 1);
    selected.push(candidate);
  };

  const take = (lane: DiscoveryLane, limit: number, balancedPass: boolean): void => {
    for (const candidate of ranked) {
      if (selected.length >= total || selected.filter((item) => item.lane === lane).length >= limit) break;
      if (candidate.lane !== lane || !canTake(candidate, balancedPass)) continue;
      remember(candidate);
    }
  };

  take("ORIGINAL", quotas.ORIGINAL, true);
  take("COUNTER", quotas.COUNTER, true);
  for (const candidate of ranked) {
    if (selected.length >= total) break;
    if (!canTake(candidate, false)) continue;
    remember(candidate);
  }
  return selected;
}
