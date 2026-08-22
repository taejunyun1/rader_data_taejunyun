import type { IngestChannel, InputFormat, NormalizationReport, QualityStatus, VersionOrigin, VersionReviewStatus } from "./ingestion";

export const VIEWS = ["RADAR", "DISTILL", "RESERVOIR", "INBOX", "DISCOVER", "USAGE", "SETTINGS"] as const;
export type View = (typeof VIEWS)[number];

export const SOURCE_KINDS = [
  "PERSONAL_WORK",
  "PERSONAL_TEXT",
  "PAPER_ACADEMIC",
  "BOOK_ARTICLE",
  "ARTIST_ARTWORK",
  "TECHNICAL",
  "WEB",
  "NOTE",
  "DISCOVERY",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type Reliability = "PRIMARY" | "SECONDARY" | "DISCOVERY" | "SPECULATIVE";

export type ProvenanceClass =
  | "SOURCE"
  | "INTERPRETATION"
  | "SYNTHESIS"
  | "SPECULATION"
  | "ARTISTIC_PROPOSITION";

export type UserAction =
  | "import"
  | "view"
  | "select"
  | "keep"
  | "watch"
  | "develop"
  | "ignore";

export * from "./ingestion";

/** Actions that keep a source in the next research context until the next distill run. */
export const NEXT_RESEARCH_MARK_ACTIONS = ["keep", "develop"] as const;

export function isNextResearchMarkAction(action: string | null | undefined): boolean {
  return action === "keep" || action === "develop";
}

export type ProcessingStatus =
  | "received"
  | "stored"
  | "extracted"
  | "analyzed"
  | "indexed"
  | "failed";

export type ThreadStatus =
  | "SEED"
  | "QUESTION"
  | "THREAD"
  | "DIRECTION"
  | "DEVELOPING"
  | "ARCHIVED";

export type RadarPeriod = "WEEKLY" | "MONTHLY" | "YEARLY";

export type QueuePriority = "MUST" | "WORTH" | "REFERENCE";

export type DiscoveryStatus = "CANDIDATE" | "KEPT" | "WATCHED" | "IGNORED";

export interface DiscoverySourcePreset {
  id: string;
  name: string;
  category: "ARTS" | "ACADEMIC" | "EDITORIAL";
  url: string;
  feedUrl: string | null;
  description: string;
}

/** Curated entry points shown in Discover. Only public RSS/Atom feeds are auto-collected. */
export const DISCOVERY_SOURCE_PRESETS: readonly DiscoverySourcePreset[] = [
  {
    id: "e-flux-journal",
    name: "e-flux Journal",
    category: "ARTS",
    url: "https://www.e-flux.com/journal",
    feedUrl: null,
    description: "동시대 미술·이론·이미지 비평을 읽는 출발점",
  },
  {
    id: "e-flux-announcements",
    name: "e-flux Announcements",
    category: "ARTS",
    url: "https://www.e-flux.com/announcements",
    feedUrl: null,
    description: "전시·기관·오픈콜·교육 프로그램 소식",
  },
  {
    id: "artforum",
    name: "Artforum",
    category: "ARTS",
    url: "https://www.artforum.com/",
    feedUrl: "https://www.artforum.com/feed",
    description: "전시 비평·인터뷰·동시대 미술 뉴스",
  },
  {
    id: "hyperallergic",
    name: "Hyperallergic",
    category: "EDITORIAL",
    url: "https://hyperallergic.com/",
    feedUrl: "https://hyperallergic.com/feed/",
    description: "미술계 현장과 비평, 디지털·뉴미디어 관련 읽을거리",
  },
  {
    id: "artnews",
    name: "ARTnews",
    category: "EDITORIAL",
    url: "https://www.artnews.com/",
    feedUrl: "https://www.artnews.com/c/art-news/feed/",
    description: "미술계 주요 뉴스와 작가·기관 동향",
  },
  {
    id: "riss",
    name: "RISS",
    category: "ACADEMIC",
    url: "https://www.riss.kr/",
    feedUrl: null,
    description: "국내 학술지·학위논문 검색 출발점 — API 키 연동 필요",
  },
] as const;

export const DEFAULT_DISCOVERY_FEEDS = DISCOVERY_SOURCE_PRESETS.flatMap((source) => (source.feedUrl ? [source.feedUrl] : []));

export interface HealthResponse {
  ok: true;
  service: string;
  time: string;
}

export interface InboxItem {
  sourceId: string;
  title: string;
  kind: SourceKind;
  reliability: Reliability;
  origin: string | null;
  ingestChannel?: IngestChannel;
  inputFormat?: InputFormat;
  qualityStatus?: QualityStatus;
  activeVersionId?: string | null;
  versionCount?: number;
  pendingVersionCount?: number;
  analysisFresh?: boolean;
  charCount?: number;
  activeVersion?: InboxVersionSummary | null;
  status: ProcessingStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface InboxVersionSummary {
  id: string;
  version: number;
  origin: VersionOrigin;
  reviewStatus: VersionReviewStatus;
  normalizationStatus: string;
  qualityStatus: QualityStatus;
  charCount: number;
  createdAt: string;
  reviewedAt: string | null;
  isActive: boolean;
}

export interface InboxDetail {
  item: InboxItem;
  original: {
    available: boolean;
    r2Key: string | null;
    url: string;
  };
  activeVersion: (InboxVersionSummary & {
    extractedText: string | null;
    normalizedText: string | null;
    report: NormalizationReport | null;
  }) | null;
  versions: Array<InboxVersionSummary & { parentVersionId: string | null }>;
}

export interface RadarParams {
  familiarity: number;
  researchDepth: number;
  divergence: number;
  counterStrength: number;
  technicalPhotographic: number;
}

export type PresetName =
  | "BALANCED"
  | "DEEP_RESEARCH"
  | "ARTWORK_EXPLORATION"
  | "COUNTER_HEAVY"
  | "TECHNICAL";

export const PRESETS: Record<PresetName, RadarParams> = {
  BALANCED: { familiarity: 0.5, researchDepth: 0.5, divergence: 0.5, counterStrength: 0.5, technicalPhotographic: 0.5 },
  DEEP_RESEARCH: { familiarity: 0.3, researchDepth: 0.9, divergence: 0.3, counterStrength: 0.3, technicalPhotographic: 0.6 },
  ARTWORK_EXPLORATION: { familiarity: 0.4, researchDepth: 0.3, divergence: 0.6, counterStrength: 0.6, technicalPhotographic: 0.2 },
  COUNTER_HEAVY: { familiarity: 0.3, researchDepth: 0.5, divergence: 0.8, counterStrength: 0.9, technicalPhotographic: 0.5 },
  TECHNICAL: { familiarity: 0.6, researchDepth: 0.7, divergence: 0.3, counterStrength: 0.4, technicalPhotographic: 0.9 },
};
