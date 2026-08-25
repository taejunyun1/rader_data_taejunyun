import type {
  VisualExtractionRunStatus,
  VisualExtractionUnitStatus,
  VisualOriginKind,
} from "@radar/shared";

export const VISUAL_EXTRACTION_RUN_STATUSES = [
  "UPLOADING",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly VisualExtractionRunStatus[];

export const VISUAL_EXTRACTION_UNIT_STATUSES = [
  "UPLOADED",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "DELETED",
] as const satisfies readonly VisualExtractionUnitStatus[];

export interface VisualExtractionRunRow {
  id: string;
  parentSourceId: string;
  parentVersionId: string;
  originKind: VisualOriginKind;
  status: VisualExtractionRunStatus;
  totalUnits: number;
  uploadedUnits: number;
  processedUnits: number;
  selectedCount: number;
  reviewCount: number;
  filteredCount: number;
  unavailableCount: number;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  visionCallLimit: number;
  visionReservationUsd: number;
  visionBudgetReserved: boolean;
  visionBudgetBlocked: number;
  visionSlotsUsed: number;
  visionAttempted: number;
  visionCompleted: number;
  visionFailed: number;
  visionBlocked: number;
  visionCapBlocked: number;
}

export interface VisualExtractionUnitRow {
  id: string;
  runId: string;
  unitNumber: number;
  candidateKey: string;
  status: VisualExtractionUnitStatus;
  tempR2Key: string | null;
  width: number | null;
  height: number | null;
  contentHash: string | null;
  errorCode: string | null;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
  deletedAt: string | null;
}

export interface CreateOrResumeRunInput {
  parentSourceId: string;
  parentVersionId: string;
  originKind: VisualOriginKind;
  now?: string;
}

export interface RecordExtractionUnitInput {
  runId: string;
  unitNumber: number;
  candidateKey: string;
  tempR2Key?: string | null;
  width?: number | null;
  height?: number | null;
  contentHash?: string | null;
  createdAt?: string;
}

export interface MarkExtractionUnitProcessedInput {
  runId: string;
  unitNumber: number;
  candidateKey: string;
  status: Extract<VisualExtractionUnitStatus, "PROCESSING" | "SUCCEEDED" | "FAILED" | "DELETED">;
  width?: number | null;
  height?: number | null;
  contentHash?: string | null;
  errorCode?: string | null;
  error?: string | null;
  processedAt?: string;
}

export interface FinishExtractionRunInput {
  runId: string;
  counts: {
    selected: number;
    review: number;
    filtered: number;
    unavailable: number;
  };
  status?: Exclude<VisualExtractionRunStatus, "UPLOADING" | "QUEUED" | "RUNNING">;
  errorCode?: string | null;
  error?: string | null;
  finishedAt?: string;
}

export interface CancelExtractionRunInput {
  runId: string;
  errorCode?: string | null;
  error?: string | null;
  cancelledAt?: string;
}

export interface ListExpiredExtractionUnitsInput {
  olderThan: string;
}
