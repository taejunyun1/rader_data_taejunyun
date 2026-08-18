export const VIEWS = ["RADAR", "DISTILL", "RESERVOIR", "INBOX", "DISCOVER", "SETTINGS"] as const;
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
  status: ProcessingStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
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
