import type { DiscoveryProfile, DiscoveryLane, DiscoveryQuerySource } from "@radar/shared/discovery";
import {
  isUsableDiscoveryQuery,
  normalizeDiscoveryTitle,
  strengthQueryLimit,
} from "@radar/shared/discovery";
import type { DiscoveryQueryPlanItem } from "@radar/shared/discoveryRun";

export interface DiscoveryQueryPlanInput {
  profile: DiscoveryProfile;
  homepageKeywords: string[];
  momentumKeywords: string[];
  legacyQueries: string[];
}

type Concept = {
  id: string;
  pattern: RegExp;
};

const concepts: Concept[] = [
  { id: "PHOTOGRAPHY", pattern: /사진|photograph|photographic/i },
  { id: "VISUAL_CULTURE", pattern: /시각문화|visual culture|visuality/i },
  { id: "IMAGE", pattern: /이미지|image|visual/i },
  { id: "AI_VISUAL", pattern: /\bai\b|인공지능|알고리즘|머신비전|machine vision|computer vision/i },
  { id: "NETWORK_DATA", pattern: /네트워크|network|플랫폼|platform|데이터|\bdata\b/i },
  { id: "MATERIALITY", pattern: /물질|material|촉각|tactil|print|labor/i },
  { id: "REPRESENTATION", pattern: /재현|representation|저자|authorship|저작권|copyright|provenance/i },
  { id: "TESTIMONY", pattern: /증언|testimony/i },
  { id: "CONTEXT", pattern: /기억|기록|아카이브|archive|memory|맥락|context/i },
  { id: "RECEPTION_FIELD", pattern: /수용|사용|현장|reception|use|field practice|site-specific/i },
  { id: "COMPARISON", pattern: /비교|블라인드|comparison|blind/i },
  { id: "METHOD", pattern: /변수|통제|조건|methodology|technical variables|control/i },
];

const anchorPriority = [
  "PHOTOGRAPHY",
  "VISUAL_CULTURE",
  "IMAGE",
  "MATERIALITY",
  "NETWORK_DATA",
  "AI_VISUAL",
] as const;

const counterModifierPriority = [
  "COMPARISON",
  "RECEPTION_FIELD",
  "TESTIMONY",
  "CONTEXT",
  "METHOD",
  "REPRESENTATION",
  "NETWORK_DATA",
  "MATERIALITY",
  "AI_VISUAL",
  "IMAGE",
  "PHOTOGRAPHY",
] as const;

function cleanSourceQuery(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasKorean(value: string): boolean {
  return /[\uac00-\ud7a3]/u.test(value);
}

function conceptIds(value: string): string[] {
  return concepts.filter((concept) => concept.pattern.test(value)).map((concept) => concept.id);
}

function uniqueParts(parts: string[]): string {
  return [...new Set(parts.flatMap((part) => part.split(/\s+/u).filter(Boolean)))].join(" ");
}

function originalProviderQuery(sourceQuery: string, ids: string[]): string | null {
  if (ids.length === 0) {
    if (!hasKorean(sourceQuery) && sourceQuery.length <= 80 && isUsableDiscoveryQuery(sourceQuery)) {
      return normalizeDiscoveryTitle(sourceQuery);
    }
    return null;
  }

  const lower = sourceQuery.toLowerCase();
  const hasPhoto = ids.includes("PHOTOGRAPHY");
  const hasImage = ids.includes("IMAGE");
  const hasVisualCulture = ids.includes("VISUAL_CULTURE");
  const hasAi = ids.includes("AI_VISUAL");
  const hasNetwork = /네트워크|network|플랫폼|platform/i.test(lower);
  const hasData = /데이터|\bdata\b/i.test(lower);
  const hasRepresentation = ids.includes("REPRESENTATION");
  const parts: string[] = [];

  if (hasPhoto) parts.push("photography");
  if (hasNetwork) parts.push("network culture");
  if (hasData) parts.push("data epistemology");
  if (hasAi) parts.push("AI algorithm");
  if (hasImage && !hasPhoto && !hasNetwork) parts.push("image theory");
  if (ids.includes("MATERIALITY")) parts.push("materiality tactility");
  if (hasRepresentation) parts.push("representation authorship");
  if (ids.includes("TESTIMONY")) parts.push("testimony");
  if (ids.includes("CONTEXT")) parts.push("memory archive context");
  if (ids.includes("RECEPTION_FIELD")) parts.push("reception field practice");

  if (hasNetwork && hasImage) parts.push("image theory");
  if (hasData && !hasPhoto && !hasImage && !hasNetwork) parts.push("photography");
  if (hasAi || hasVisualCulture) parts.push("visual culture");
  if (hasImage && !hasPhoto && !hasNetwork && !hasAi && !hasVisualCulture) parts.push("visual culture");
  if (parts.length === 0) parts.push("visual culture");

  return uniqueParts(parts);
}

function contextAnchor(sourceQueries: string[]): string {
  const found = new Set(sourceQueries.flatMap(conceptIds));
  for (const id of anchorPriority) {
    if (found.has(id)) {
      if (id === "PHOTOGRAPHY") return "photography";
      if (id === "VISUAL_CULTURE") return "visual culture";
      if (id === "IMAGE") return "image theory";
      if (id === "MATERIALITY") return "materiality tactility";
      if (id === "NETWORK_DATA") return "network culture";
      return "visual culture";
    }
  }
  return "visual culture";
}

function counterProviderQuery(sourceQuery: string, ids: string[], anchor: string): string | null {
  if (ids.length === 0) return null;
  const lower = sourceQuery.toLowerCase();
  const parts: string[] = [];
  for (const id of counterModifierPriority) {
    if (!ids.includes(id)) continue;
    if (id === "COMPARISON") parts.push("comparison");
    if (id === "RECEPTION_FIELD") parts.push("reception field practice");
    if (id === "TESTIMONY") parts.push("testimony");
    if (id === "CONTEXT") parts.push("context");
    if (id === "METHOD") parts.push(/변수|technical variables/i.test(lower) ? "technical variables" : "technical control");
    if (id === "REPRESENTATION") parts.push("representation authorship");
    if (id === "NETWORK_DATA") parts.push("network data");
    if (id === "MATERIALITY") parts.push("materiality tactility");
    if (id === "AI_VISUAL") parts.push("AI algorithm");
    if (id === "IMAGE") parts.push("image theory");
    if (id === "PHOTOGRAPHY") parts.push("photography");
    if (parts.length >= 2) break;
  }
  return parts.length > 0 ? uniqueParts([anchor, ...parts.slice(0, 2)]) : null;
}

function providersFor(ids: string[]): Array<"openalex" | "arxiv"> {
  const providers: Array<"openalex" | "arxiv"> = ["openalex"];
  if (ids.some((id) => ["PHOTOGRAPHY", "VISUAL_CULTURE", "IMAGE", "AI_VISUAL"].includes(id))) {
    providers.push("arxiv");
  }
  return providers;
}

function addSource(
  target: Array<{ sourceQuery: string; lane: DiscoveryLane; querySource: DiscoveryQuerySource }>,
  values: string[],
  lane: DiscoveryLane,
  querySource: DiscoveryQuerySource,
  seenByLane: Map<DiscoveryLane, Set<string>>,
): void {
  const seen = seenByLane.get(lane) ?? new Set<string>();
  seenByLane.set(lane, seen);
  for (const value of values) {
    if (typeof value !== "string") continue;
    const sourceQuery = cleanSourceQuery(value);
    const key = normalizeDiscoveryTitle(sourceQuery);
    if (!sourceQuery || !key || seen.has(key)) continue;
    seen.add(key);
    target.push({ sourceQuery, lane, querySource });
  }
}

export function buildDiscoveryQueryPlan(input: DiscoveryQueryPlanInput): DiscoveryQueryPlanItem[] {
  const raw: Array<{ sourceQuery: string; lane: DiscoveryLane; querySource: DiscoveryQuerySource }> = [];
  const seenByLane = new Map<DiscoveryLane, Set<string>>();

  addSource(raw, input.profile.original.keywords, "ORIGINAL", "SAVED", seenByLane);
  addSource(raw, input.profile.counter.keywords, "COUNTER", "SAVED", seenByLane);
  addSource(raw, input.homepageKeywords, "ORIGINAL", "RECOMMENDED", seenByLane);
  addSource(raw, input.momentumKeywords, "ORIGINAL", "MOMENTUM", seenByLane);
  addSource(raw, input.legacyQueries, "ORIGINAL", "FEED", seenByLane);

  const originalSources = raw.filter((item) => item.lane === "ORIGINAL").map((item) => item.sourceQuery);
  const anchorSource = originalSources.find((sourceQuery) => conceptIds(sourceQuery).length > 0);
  const anchor = contextAnchor(anchorSource ? [anchorSource] : []);
  const plan = raw.map<DiscoveryQueryPlanItem>((item) => {
    const ids = conceptIds(item.sourceQuery);
    const providerQuery = item.lane === "COUNTER"
      ? counterProviderQuery(item.sourceQuery, ids, anchor)
      : originalProviderQuery(item.sourceQuery, ids);
    const status = providerQuery ? "READY" : "UNSUPPORTED";
    return {
      sourceQuery: item.sourceQuery,
      providerQuery,
      lane: item.lane,
      querySource: item.querySource,
      concepts: ids,
      providers: providerQuery ? providersFor(ids) : [],
      status,
      selected: false,
      unsupportedReason: providerQuery ? null : "NO_MAPPABLE_CONCEPT",
    };
  });

  for (const lane of ["ORIGINAL", "COUNTER"] as const) {
    let selected = 0;
    const limit = strengthQueryLimit(lane === "ORIGINAL" ? input.profile.original.strength : input.profile.counter.strength);
    for (const item of plan) {
      if (item.lane !== lane || item.status !== "READY" || selected >= limit) continue;
      item.selected = true;
      selected++;
    }
  }
  return plan;
}
