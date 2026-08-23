import type { DiscoveryProfile } from "./discovery";
import { discoveryProviderQuery, normalizeDiscoveryTitle } from "./discovery";

export const DISCOVERY_FIELD_SIGNAL_MIN_SCORE = 0.55;

export type DiscoveryFieldSignalType =
  | "CONFERENCE"
  | "CALL_FOR_PAPERS"
  | "EXHIBITION"
  | "GRANT"
  | "RESIDENCY"
  | "WORKSHOP"
  | "INSTITUTION_NEWS"
  | "OTHER";

export type DiscoveryFieldSignalStatus = "NEW" | "SAVED" | "DISMISSED";

export type DiscoveryFieldSignalRejectionReason =
  | "NO_RESEARCH_MATCH"
  | "STALE"
  | "EXPIRED"
  | "MISSING_URL"
  | "DUPLICATE"
  | "SOURCE_QUOTA";

export interface DiscoveryFieldSignal {
  id: string;
  sourceId: string;
  sourceName: string;
  externalUrl: string;
  title: string;
  summary: string | null;
  signalType: DiscoveryFieldSignalType;
  publishedAt: string | null;
  eventAt: string | null;
  deadlineAt: string | null;
  matchedTerms: string[];
  relevanceScore: number;
  status: DiscoveryFieldSignalStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveryFieldSignalAssessmentInput {
  title: string;
  summary?: string | null;
  publishedAt?: string | null;
  profile: DiscoveryProfile;
  sourceAnchors: string[];
  now?: Date;
}

export interface DiscoveryFieldSignalAssessment {
  accepted: boolean;
  reason: "RELEVANT" | DiscoveryFieldSignalRejectionReason;
  score: number;
  signalType: DiscoveryFieldSignalType;
  matchedTerms: string[];
  eventAt: string | null;
  deadlineAt: string | null;
}

const TYPE_PATTERNS: Array<[DiscoveryFieldSignalType, RegExp]> = [
  ["CALL_FOR_PAPERS", /\b(call for papers?|cfp|call for proposals?|paper submissions?)\b/i],
  ["RESIDENCY", /\b(residenc(?:y|ies)|artist in residence|open call)\b/i],
  ["GRANT", /\b(grants?|fellowships?|funding|award applications?)\b/i],
  ["CONFERENCE", /\b(conferences?|symposi(?:um|a)|congress|annual meeting)\b/i],
  ["EXHIBITION", /\b(exhibitions?|biennial|triennial|on view|opening)\b/i],
  ["WORKSHOP", /\b(workshops?|seminars?|masterclasses?|lecture series)\b/i],
  ["INSTITUTION_NEWS", /\b(appoints?|announces?|acquires?|collection|museum news|prize winners?)\b/i],
];

const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

export function classifyDiscoveryFieldSignalType(text: string): DiscoveryFieldSignalType {
  return TYPE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "OTHER";
}

function isoDate(year: number, monthIndex: number, day: number): string | null {
  const date = new Date(Date.UTC(year, monthIndex, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === monthIndex && date.getUTCDate() === day
    ? date.toISOString()
    : null;
}

export function extractDiscoveryFieldSignalDates(
  text: string,
  defaultYear: number,
): { eventAt: string | null; deadlineAt: string | null } {
  const deadlineMatch = text.match(/(?:apply by|deadline|closes?|due)\D{0,12}(\d{4})-(\d{2})-(\d{2})/i);
  const deadlineAt = deadlineMatch
    ? isoDate(Number(deadlineMatch[1]), Number(deadlineMatch[2]) - 1, Number(deadlineMatch[3]))
    : null;
  const monthMatch = text.match(new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?`, "i"));
  const eventAt = monthMatch
    ? isoDate(Number(monthMatch[3] ?? defaultYear), MONTHS[monthMatch[1]!.toLowerCase()]!, Number(monthMatch[2]))
    : null;
  return { eventAt, deadlineAt };
}

function profileTerms(profile: DiscoveryProfile): string[] {
  const values = [...profile.original.keywords, ...profile.counter.keywords];
  const tokens = values
    .flatMap((value) => [value, discoveryProviderQuery(value)])
    .flatMap((value) => normalizeDiscoveryTitle(value).split(" ").filter((token) => token.length >= 3));
  return [...new Set(tokens)];
}

export function assessDiscoveryFieldSignal(
  input: DiscoveryFieldSignalAssessmentInput,
): DiscoveryFieldSignalAssessment {
  const now = input.now ?? new Date();
  const title = normalizeDiscoveryTitle(input.title);
  const summary = normalizeDiscoveryTitle(input.summary ?? "");
  const fullText = `${title} ${summary}`.trim();
  const signalType = classifyDiscoveryFieldSignalType(fullText);
  const published = input.publishedAt ? new Date(input.publishedAt) : null;
  const ageMs = published && Number.isFinite(published.getTime()) ? now.getTime() - published.getTime() : null;
  const dates = extractDiscoveryFieldSignalDates(`${input.title} ${input.summary ?? ""}`, now.getUTCFullYear());

  if (ageMs !== null && ageMs > 365 * 24 * 60 * 60 * 1000) {
    return { accepted: false, reason: "STALE", score: 0, signalType, matchedTerms: [], ...dates };
  }

  const currentDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const actionableAt = dates.deadlineAt ?? dates.eventAt;
  if (actionableAt && new Date(actionableAt).getTime() < currentDay) {
    return { accepted: false, reason: "EXPIRED", score: 0, signalType, matchedTerms: [], ...dates };
  }

  const terms = profileTerms(input.profile);
  const sourceTerms = input.sourceAnchors.flatMap((value) =>
    normalizeDiscoveryTitle(value).split(" ").filter((token) => token.length >= 3),
  );
  const titleMatches = terms.filter((term) => title.includes(term));
  const summaryMatches = terms.filter((term) => summary.includes(term));
  const matchedTerms = [...new Set([...titleMatches, ...summaryMatches])].slice(0, 8);
  const sourceMatches = [...new Set(sourceTerms.filter((term) => fullText.includes(term)))];

  if (sourceMatches.length === 0 && matchedTerms.length === 0) {
    return { accepted: false, reason: "NO_RESEARCH_MATCH", score: 0.1, signalType, matchedTerms, ...dates };
  }

  if (signalType === "OTHER" && matchedTerms.length === 0) {
    return { accepted: false, reason: "NO_RESEARCH_MATCH", score: 0.25, signalType, matchedTerms, ...dates };
  }

  let score = 0.25;
  if (sourceMatches.length > 0) score += 0.15;
  if (titleMatches.length > 0) score += 0.2;
  if (summaryMatches.length > 0) score += 0.1;
  if (signalType !== "OTHER") score += 0.15;
  if (ageMs === null || ageMs <= 90 * 24 * 60 * 60 * 1000) score += 0.1;

  const rounded = Math.min(1, Number(score.toFixed(2)));
  return {
    accepted: rounded >= DISCOVERY_FIELD_SIGNAL_MIN_SCORE,
    reason: rounded >= DISCOVERY_FIELD_SIGNAL_MIN_SCORE ? "RELEVANT" : "NO_RESEARCH_MATCH",
    score: rounded,
    signalType,
    matchedTerms,
    ...dates,
  };
}
