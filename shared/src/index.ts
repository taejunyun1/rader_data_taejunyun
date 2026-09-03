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
export * from "./discovery";
export * from "./discoveryRun";
export * from "./fieldSignals";
export * from "./visual";
export * from "./visualAnalysis";
export * from "./homepagePublication";
export * from "./distill";

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

export interface AiModelRoles {
  baseModel: string;
  reviewModel: string;
}

export type DiscoveryContentTarget = "READING" | "FIELD_SIGNAL";
export type DiscoverySourceAccessPolicy = "FREE_FULLTEXT" | "PAYWALLED" | "INSTITUTION" | "UNKNOWN";

export interface DiscoverySourcePreset {
  id: string;
  name: string;
  category: "ARTS" | "ACADEMIC" | "EDITORIAL";
  url: string;
  feedUrl: string | null;
  collection: "RSS" | "API" | "SEARCH";
  target: DiscoveryContentTarget;
  autoCollect: boolean;
  accessPolicy: DiscoverySourceAccessPolicy;
  topicAnchors: string[];
  description: string;
}

const NEW_DIRECTORY_DESCRIPTIONS = {
  kci: "국내 학술지 인용색인 — 공식 API 키·이용 조건 확인 필요",
  kiss: "국내 학술지 원문·서지 검색 — 공식 API 신청·이용 조건 확인 필요",
  dbpia: "국내 학술 콘텐츠 검색 — 공식 API 키·원문 이용 조건 확인 필요",
  "national-assembly-library": "국회전자도서관 학술·정부자료 — 공식 Open API 신청·이용 조건 확인 필요",
  scienceon: "KISTI 과학기술정보 검색 — 공식 Open API 신청·이용 조건 확인 필요",
  "korean-photography-society-jams": "한국사진학회 AURA — JAMS 학술지·논문 검색 출발점",
  arxiv: "해외 프리프린트·논문 — 공식 API로 메타데이터 확인",
  lenscratch: "동시대 사진·작가·전시 비평 — 공개 RSS로 새 글 확인",
  "smb-berlin": "미술관 연구·전시·컬렉션 소식 — 공개 RSS로 현장 신호 확인",
  "semantic-scholar": "학술 문헌·인용 그래프 — 공식 API adapter 구현 전 디렉터리 전용",
  core: "오픈액세스 논문 집합 — 공식 API adapter와 이용 한도 확인 필요",
  doaj: "오픈액세스 학술지 색인 — 공식 API adapter 구현 전 디렉터리 전용",
  "fotomuseum-winterthur": "사진·네트워크 문화·이미지 이론 연구와 비평",
  foam: "사진 전시·비평·작가·출판을 잇는 미술관 출발점",
  "one-thousand-words": "동시대 사진과 포토북 중심의 비평 매거진",
} as const;

/** Curated entry points shown in Discover. Only approved public RSS feeds are auto-collected without credentials. */
export const DISCOVERY_SOURCE_PRESETS: readonly DiscoverySourcePreset[] = [
  {
    id: "unthinking-photography",
    name: "Unthinking Photography",
    category: "ARTS",
    url: "https://unthinking.photography/",
    feedUrl: "https://unthinking.photography/feed",
    collection: "RSS",
    target: "READING",
    autoCollect: true,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "network culture", "machine vision", "visual culture"],
    description: "자동화·네트워크화된 사진, AI·머신비전·이미지 문화 비평",
  },
  {
    id: "aperture",
    name: "Aperture",
    category: "ARTS",
    url: "https://aperture.org/",
    feedUrl: "https://aperture.org/feed/",
    collection: "RSS",
    target: "READING",
    autoCollect: true,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "photographic history", "visual culture"],
    description: "사진 매체의 비평·작가·전시·출판 소식",
  },
  {
    id: "hyperallergic",
    name: "Hyperallergic",
    category: "EDITORIAL",
    url: "https://hyperallergic.com/",
    feedUrl: "https://hyperallergic.com/rss/",
    collection: "RSS",
    target: "READING",
    autoCollect: true,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["contemporary art", "media art", "visual culture"],
    description: "미술계 현장과 비평, 디지털·뉴미디어 관련 읽을거리",
  },
  {
    id: "lenscratch",
    name: "Lenscratch",
    category: "ARTS",
    url: "https://lenscratch.com/",
    feedUrl: "https://lenscratch.com/feed/",
    collection: "RSS",
    target: "READING",
    autoCollect: true,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "photographic history", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS.lenscratch,
  },
  {
    id: "caa-news",
    name: "CAA News",
    category: "ACADEMIC",
    url: "https://www.collegeart.org/news/",
    feedUrl: "https://www.collegeart.org/news/feed/",
    collection: "RSS",
    target: "FIELD_SIGNAL",
    autoCollect: true,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["visual arts", "art history", "contemporary art"],
    description: "미술사·시각예술 학회, CFP, 지원과 전문 소식",
  },
  {
    id: "association-art-history",
    name: "Association for Art History",
    category: "ACADEMIC",
    url: "https://forarthistory.org.uk/",
    feedUrl: "https://forarthistory.org.uk/feed/",
    collection: "RSS",
    target: "FIELD_SIGNAL",
    autoCollect: true,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["art history", "visual culture", "curatorial research"],
    description: "미술사 학회·행사·공모·큐레이터 연구 소식",
  },
  {
    id: "icp",
    name: "International Center of Photography",
    category: "ARTS",
    url: "https://www.icp.org/",
    feedUrl: "https://www.icp.org/rss.xml",
    collection: "RSS",
    target: "FIELD_SIGNAL",
    autoCollect: true,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["photography", "visual culture", "photojournalism"],
    description: "사진 전시·교육·아카이브·기관 프로그램",
  },
  {
    id: "smb-berlin",
    name: "Staatliche Museen zu Berlin",
    category: "ARTS",
    url: "https://www.smb.museum/en/",
    feedUrl: "https://www.smb.museum/en/rss-feed/press-releases.xml",
    collection: "RSS",
    target: "FIELD_SIGNAL",
    autoCollect: true,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["museum", "photography", "visual culture", "art history"],
    description: NEW_DIRECTORY_DESCRIPTIONS["smb-berlin"],
  },
  {
    id: "e-flux-journal",
    name: "e-flux Journal",
    category: "ARTS",
    url: "https://www.e-flux.com/journal",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["contemporary art", "visual culture", "media theory"],
    description: "동시대 미술·이론·이미지 비평을 읽는 출발점",
  },
  {
    id: "e-flux-announcements",
    name: "e-flux Announcements",
    category: "ARTS",
    url: "https://www.e-flux.com/announcements",
    feedUrl: null,
    collection: "SEARCH",
    target: "FIELD_SIGNAL",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["contemporary art", "curatorial research", "visual culture"],
    description: "전시·기관·오픈콜·교육 프로그램 소식",
  },
  {
    id: "artforum",
    name: "Artforum",
    category: "ARTS",
    url: "https://www.artforum.com/",
    feedUrl: "https://www.artforum.com/feed",
    collection: "RSS",
    target: "READING",
    autoCollect: false,
    accessPolicy: "PAYWALLED",
    topicAnchors: ["contemporary art", "art criticism", "visual culture"],
    description: "전시 비평·인터뷰·동시대 미술 뉴스",
  },
  {
    id: "artnews",
    name: "ARTnews",
    category: "EDITORIAL",
    url: "https://www.artnews.com/",
    feedUrl: "https://www.artnews.com/c/art-news/feed/",
    collection: "RSS",
    target: "READING",
    autoCollect: false,
    accessPolicy: "PAYWALLED",
    topicAnchors: ["contemporary art", "museum", "visual culture"],
    description: "미술계 주요 뉴스와 작가·기관 동향",
  },
  {
    id: "getty-news",
    name: "Getty News & Stories",
    category: "ARTS",
    url: "https://www.getty.edu/news/all/",
    feedUrl: null,
    collection: "SEARCH",
    target: "FIELD_SIGNAL",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["photography", "conservation", "museum research"],
    description: "미술관 전시·보존·연구·사진 관련 기관 자료",
  },
  {
    id: "moma-research",
    name: "MoMA Research & Learning",
    category: "ACADEMIC",
    url: "https://www.moma.org/research_and_learning/",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["modern art", "media art", "visual culture"],
    description: "미술관 연구·아카이브·현대미술 교육 자료",
  },
  {
    id: "riss",
    name: "RISS",
    category: "ACADEMIC",
    url: "https://www.riss.kr/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "INSTITUTION",
    topicAnchors: ["photography", "visual culture", "art history"],
    description: "국내 학술지·학위논문 검색 출발점 — API 키 연동 필요",
  },
  {
    id: "kiss",
    name: "KISS",
    category: "ACADEMIC",
    url: "https://kiss.kstudy.com/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "INSTITUTION",
    topicAnchors: ["photography", "visual culture", "art history"],
    description: NEW_DIRECTORY_DESCRIPTIONS.kiss,
  },
  {
    id: "dbpia",
    name: "DBpia",
    category: "ACADEMIC",
    url: "https://www.dbpia.co.kr/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "INSTITUTION",
    topicAnchors: ["photography", "visual culture", "art history"],
    description: NEW_DIRECTORY_DESCRIPTIONS.dbpia,
  },
  {
    id: "national-assembly-library",
    name: "국회도서관",
    category: "ACADEMIC",
    url: "https://www.nanet.go.kr/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["photography", "visual culture", "cultural policy"],
    description: NEW_DIRECTORY_DESCRIPTIONS["national-assembly-library"],
  },
  {
    id: "scienceon",
    name: "ScienceON",
    category: "ACADEMIC",
    url: "https://scienceon.kisti.re.kr/main/mainForm.do?v=2",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["machine vision", "computational photography", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS.scienceon,
  },
  {
    id: "korean-photography-society-jams",
    name: "한국사진학회 JAMS",
    category: "ACADEMIC",
    url: "https://skp.jams.or.kr/",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["photography", "photographic history", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS["korean-photography-society-jams"],
  },
  {
    id: "google-scholar",
    name: "Google Scholar",
    category: "ACADEMIC",
    url: "https://scholar.google.com/",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["photography", "visual culture", "media theory"],
    description: "전 분야 학술 문헌 검색 — 공식 자동 수집 API 없음",
  },
  {
    id: "scopus",
    name: "Scopus",
    category: "ACADEMIC",
    url: "https://www.scopus.com/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "INSTITUTION",
    topicAnchors: ["photography", "visual culture", "media theory"],
    description: "학술 초록·인용 데이터베이스 — 공식 API 키·이용 권한 필요",
  },
  {
    id: "web-of-science",
    name: "Web of Science",
    category: "ACADEMIC",
    url: "https://www.webofscience.com/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "INSTITUTION",
    topicAnchors: ["photography", "visual culture", "media theory"],
    description: "학술 문헌·인용 색인 — 공식 API 키·이용 권한 필요",
  },
  {
    id: "kci",
    name: "KCI",
    category: "ACADEMIC",
    url: "https://www.kci.go.kr/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "INSTITUTION",
    topicAnchors: ["photography", "visual culture", "art history"],
    description: NEW_DIRECTORY_DESCRIPTIONS.kci,
  },
  {
    id: "arxiv",
    name: "arXiv",
    category: "ACADEMIC",
    url: "https://arxiv.org/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["machine vision", "computational photography", "artificial intelligence"],
    description: NEW_DIRECTORY_DESCRIPTIONS.arxiv,
  },
  {
    id: "semantic-scholar",
    name: "Semantic Scholar",
    category: "ACADEMIC",
    url: "https://www.semanticscholar.org/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "UNKNOWN",
    topicAnchors: ["photography", "machine vision", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS["semantic-scholar"],
  },
  {
    id: "core",
    name: "CORE",
    category: "ACADEMIC",
    url: "https://core.ac.uk/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "visual culture", "media theory"],
    description: NEW_DIRECTORY_DESCRIPTIONS.core,
  },
  {
    id: "doaj",
    name: "DOAJ",
    category: "ACADEMIC",
    url: "https://doaj.org/",
    feedUrl: null,
    collection: "API",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "visual culture", "art history"],
    description: NEW_DIRECTORY_DESCRIPTIONS.doaj,
  },
  {
    id: "fotomuseum-winterthur",
    name: "Fotomuseum Winterthur",
    category: "ARTS",
    url: "https://www.fotomuseum.ch/en/explore/still-searching/",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "network culture", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS["fotomuseum-winterthur"],
  },
  {
    id: "foam",
    name: "FOAM",
    category: "ARTS",
    url: "https://www.foam.org/",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "photographic history", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS.foam,
  },
  {
    id: "one-thousand-words",
    name: "1000 Words",
    category: "EDITORIAL",
    url: "https://1000wordsmag.com/",
    feedUrl: null,
    collection: "SEARCH",
    target: "READING",
    autoCollect: false,
    accessPolicy: "FREE_FULLTEXT",
    topicAnchors: ["photography", "photobooks", "visual culture"],
    description: NEW_DIRECTORY_DESCRIPTIONS["one-thousand-words"],
  },
] as const;

export const DEFAULT_DISCOVERY_FEEDS = DISCOVERY_SOURCE_PRESETS.flatMap((source) =>
  source.autoCollect && source.collection === "RSS" && source.target === "READING" && source.feedUrl
    ? [source.feedUrl]
    : [],
);

export const DEFAULT_FIELD_SIGNAL_FEEDS = DISCOVERY_SOURCE_PRESETS.flatMap((source) =>
  source.autoCollect && source.collection === "RSS" && source.target === "FIELD_SIGNAL" && source.feedUrl
    ? [source.feedUrl]
    : [],
);

export function discoverySourceByFeedUrl(feedUrl: string): DiscoverySourcePreset | null {
  const normalized = feedUrl.trim().replace(/\/+$/, "");
  const direct = DISCOVERY_SOURCE_PRESETS.find((source) => source.feedUrl?.replace(/\/+$/, "") === normalized);
  if (direct) return direct;
  const legacySourceId = new Map<string, string>([
    ["https://hyperallergic.com/feed", "hyperallergic"],
  ]).get(normalized);
  return legacySourceId
    ? DISCOVERY_SOURCE_PRESETS.find((source) => source.id === legacySourceId) ?? null
    : null;
}

export function discoverySourceById(sourceId: string): DiscoverySourcePreset | null {
  return DISCOVERY_SOURCE_PRESETS.find((source) => source.id === sourceId) ?? null;
}

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
