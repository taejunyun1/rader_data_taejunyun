import type {
  VisualAnalysisReviewStatus,
  VisualAnalysisType,
  VisualAssetRole,
  VisualKind,
  VisualOriginKind,
  VisualProcessingStatus,
  VisualRightsStatus,
  VisualSelectionStatus,
  VisualStorageState,
} from "@radar/shared";

export type { VisualAnalysisReviewStatus, VisualAnalysisType, VisualAssetRole, VisualKind, VisualOriginKind, VisualProcessingStatus, VisualRightsStatus, VisualSelectionStatus, VisualStorageState };

export type VisualVariant = "ORIGINAL" | "CAPSULE" | "SVG_SOURCE";
export type VisualPerceptualHashMethod = "IMAGES_RGBA_DHASH_V1";

export interface CreatePersonalVisualInput {
  bytes: ArrayBuffer;
  filename: string;
  contentType: string;
  parentSourceId: string | null;
}

export interface VisualAssetRow {
  id: string;
  parentSourceId: string | null;
  parentVersionId: string | null;
  originKind: VisualOriginKind;
  sourceUrl: string | null;
  pageNumber: number | null;
  figureLabel: string | null;
  bboxJson: string | null;
  candidateKey: string | null;
  caption: string | null;
  nearbyText: string | null;
  assetRole: VisualAssetRole;
  visualKind: VisualKind;
  selectionStatus: VisualSelectionStatus;
  selectionReason: string | null;
  rightsStatus: VisualRightsStatus;
  rightsBasis: string | null;
  rightsReviewedAt: string | null;
  assignmentStatus: "ASSIGNED" | "UNASSIGNED";
  storageState: VisualStorageState;
  pendingStorageState: VisualStorageState | null;
  processingStatus: VisualProcessingStatus;
  lastError: string | null;
  contentHash: string | null;
  perceptualHash: string | null;
  perceptualHashMethod: VisualPerceptualHashMethod | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface VisualAssetVersionRow {
  id: string;
  visualAssetId: string;
  version: number;
  variant: VisualVariant;
  r2Key: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  contentHash: string;
  parentAssetVersionId: string | null;
  deletedAt: string | null;
}

export interface VisualRelationRow {
  id: string;
  relationKind: string;
  createdBy: "SYSTEM" | "USER";
  description: string | null;
  toVisualAssetId: string | null;
  relatedSourceId: string | null;
  relatedThreadId: string | null;
  createdAt: string;
}

export const MAX_PERSONAL_VISUAL_BYTES = 20 * 1024 * 1024;
export const ALLOWED_PERSONAL_VISUAL_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function safeVisualFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "upload";
}

export function extensionForVisualType(contentType: string, filename: string): string {
  const known = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as const;
  return known[contentType as keyof typeof known] ?? (filename.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin");
}
