export const VISUAL_STORAGE_STATES = ["ARCHIVAL", "CAPSULE", "TEXT_ONLY", "LINK_ONLY"] as const;
export type VisualStorageState = (typeof VISUAL_STORAGE_STATES)[number];

export const VISUAL_SELECTION_STATUSES = ["SELECTED", "REVIEW", "DECORATIVE", "DUPLICATE", "UNAVAILABLE"] as const;
export type VisualSelectionStatus = (typeof VISUAL_SELECTION_STATUSES)[number];

export const VISUAL_RIGHTS_STATUSES = ["PERSONAL", "PERMITTED", "PUBLIC_LINK", "UNKNOWN", "RESTRICTED"] as const;
export type VisualRightsStatus = (typeof VISUAL_RIGHTS_STATUSES)[number];

export const VISUAL_KINDS = ["PHOTO", "ARTWORK", "INSTALLATION", "GRAPHIC", "DIAGRAM", "DOCUMENT_SCAN", "OTHER"] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

export type VisualOriginKind = "PERSONAL_UPLOAD" | "PDF_PAGE_CROP" | "WEB_EMBED" | "DISCOVERY_EMBED";
export type VisualAssetRole = "PERSONAL_WORK" | "REFERENCE" | "DOCUMENTATION" | "UNKNOWN";
export type VisualProcessingStatus = "UPLOADED" | "TRANSFORM_PENDING" | "TRANSFORMING" | "ANALYSIS_PENDING" | "ANALYZING" | "READY" | "FAILED";
export type VisualAnalysisType = "AUTO_SUGGESTION" | "USER_VERIFIED";
export type VisualAnalysisReviewStatus = "PENDING" | "ACCEPTED" | "EDITED" | "DISMISSED";

export interface VisualAnalysisSummary {
  id: string;
  payload: Record<string, unknown>;
  provenanceClass: "INTERPRETATION" | "ARTISTIC_PROPOSITION";
  confidence: number | null;
  reviewStatus: VisualAnalysisReviewStatus;
  modelId: string | null;
  promptVersion: string | null;
  createdAt: string;
}

export interface VisualAssetSummary {
  id: string;
  parentSourceId: string | null;
  parentVersionId: string | null;
  originKind: VisualOriginKind;
  sourceUrl: string | null;
  pageNumber: number | null;
  figureLabel: string | null;
  caption: string | null;
  visualKind: VisualKind;
  selectionStatus: VisualSelectionStatus;
  selectionReason: string | null;
  rightsStatus: VisualRightsStatus;
  storageState: VisualStorageState;
  pendingStorageState: VisualStorageState | null;
  processingStatus: VisualProcessingStatus;
  perceptualHash: string | null;
  capsuleVersionId: string | null;
  thumbnailUrl: string | null;
  analysis: VisualAnalysisSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface VisualAssetListResponse {
  items: VisualAssetSummary[];
}
