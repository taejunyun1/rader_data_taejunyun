export type DiscoveryProvider = "openalex" | "arxiv" | "rss" | "riss" | "unknown";

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
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:nbsp|#160);/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'");
}

export function normalizeDiscoveryTitle(value: string): string {
  return decodeEntityText(value)
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanDiscoverySourceText(value: string): string {
  return decodeEntityText(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return decodeEntityText(value).toLowerCase().replace(/[“”‘’]/g, "'").replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isUsableDiscoveryQuery(query: string): boolean {
  const normalized = normalizeDiscoveryTitle(query);
  return Boolean(normalized) && !GENERIC_QUERY_SEEDS.has(normalized);
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

export function classifyDiscoveryAccess(provider: string | null | undefined, href: string | null | undefined): DiscoveryAccessStatus {
  const normalizedProvider = provider?.toLowerCase() ?? "";
  const normalizedHref = href?.toLowerCase() ?? "";
  if (!href) return "UNKNOWN";
  if (normalizedProvider === "arxiv" || normalizedHref.includes("arxiv.org/abs/") || normalizedHref.includes("arxiv.org/pdf/")) return "PDF";
  if (normalizedProvider === "riss" || normalizedHref.includes("riss.kr")) return "INSTITUTION";
  if (normalizedHref.includes("artforum.com") || normalizedHref.includes("artnews.com")) return "PAYWALLED";
  if (normalizedHref.includes("hyperallergic.com")) return "FREE_FULLTEXT";
  if (normalizedHref.endsWith(".pdf")) return "PDF";
  if (normalizedProvider === "openalex") return "UNKNOWN";
  return "UNKNOWN";
}

export interface SelectableDiscoveryCandidate {
  externalId: string;
  provider: string;
  title: string;
  score: number;
  keywordOverlap?: number;
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
