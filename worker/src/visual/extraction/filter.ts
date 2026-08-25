import type { VisualOriginKind, VisualRightsStatus, VisualSelectionStatus } from "@radar/shared";
import { uuid } from "../../ingestion/ids";

export const VISUAL_FILTER_RULE_VERSION = "visual-filter-v1" as const;
const DECORATIVE_SIGNALS = new Set(["tracker_pixel", "repeated_logo", "decorative_icon", "ad_related"]);
const EXTERNAL_LINK_ONLY_RIGHTS = new Set<VisualRightsStatus>(["UNKNOWN", "RESTRICTED", "PUBLIC_LINK"]);
const NEAR_DUPLICATE_HAMMING_THRESHOLD = 6;

export interface ExistingVisualFingerprint {
  assetId: string;
  contentHash: string | null;
  perceptualHash: string | null;
}

export interface DuplicateRelationDecision {
  relationKind: "DUPLICATE_OF";
  toVisualAssetId: string;
  description: string;
}

export interface VisualFilterDecision {
  selectionStatus: VisualSelectionStatus;
  selectionReason: string;
  ruleVersion: typeof VISUAL_FILTER_RULE_VERSION;
  duplicateOf: DuplicateRelationDecision | null;
}

export interface FilterVisualCandidateInput {
  contentHash: string | null;
  perceptualHash: string | null;
  caption: string | null;
  nearbyText: string | null;
  signals: string[];
  existingAssets: ExistingVisualFingerprint[];
}

export interface LinkOnlyVisualDraftInput {
  now?: string;
  idFactory?: () => string;
  parentSourceId: string;
  parentVersionId: string;
  originKind: VisualOriginKind;
  candidateKey: string;
  sourceUrl: string;
  finalUrl: string;
  figureLabel: string | null;
  caption: string | null;
  nearbyText: string | null;
  pageNumber?: number | null;
  bboxJson?: string | null;
  contentType: string;
  byteSize: number;
  contentHash: string;
  perceptualHash?: string | null;
  rightsStatus: VisualRightsStatus;
  rightsBasis: string | null;
  decision: VisualFilterDecision;
}

export interface LinkOnlyVisualDraft {
  persistBytes: false;
  asset: {
    id: string;
    parentSourceId: string;
    parentVersionId: string;
    originKind: VisualOriginKind;
    sourceUrl: string;
    pageNumber: number | null;
    figureLabel: string | null;
    bboxJson: string | null;
    candidateKey: string;
    caption: string | null;
    nearbyText: string | null;
    assetRole: "REFERENCE";
    visualKind: "OTHER";
    selectionStatus: VisualSelectionStatus;
    selectionReason: string;
    rightsStatus: VisualRightsStatus;
    rightsBasis: string | null;
    rightsReviewedAt: string;
    assignmentStatus: "ASSIGNED";
    storageState: "LINK_ONLY";
    pendingStorageState: null;
    processingStatus: "READY";
    lastError: null;
    contentHash: string;
    perceptualHash: string | null;
    perceptualHashMethod: "IMAGES_RGBA_DHASH_V1" | null;
    createdAt: string;
    updatedAt: string;
    deletedAt: null;
  };
  originalVersion: {
    id: string;
    visualAssetId: string;
    version: 1;
    variant: "ORIGINAL";
    r2Key: null;
    mimeType: string;
    width: null;
    height: null;
    byteSize: number;
    contentHash: string;
    parentAssetVersionId: null;
  };
  provenance: {
    sourceUrl: string;
    finalUrl: string;
    caption: string | null;
    nearbyText: string | null;
    contentHash: string;
    selectionReason: string;
    ruleVersion: typeof VISUAL_FILTER_RULE_VERSION;
  };
  relations: Array<{
    id: string;
    relationKind: "DUPLICATE_OF";
    createdBy: "SYSTEM";
    description: string;
    toVisualAssetId: string;
    relatedSourceId: null;
    relatedThreadId: null;
    createdAt: string;
  }>;
}

export function filterVisualCandidate(input: FilterVisualCandidateInput): VisualFilterDecision {
  if (input.signals.some((signal) => signal.startsWith("container:") || DECORATIVE_SIGNALS.has(signal))) {
    return createDecision("DECORATIVE", "decorative_signal");
  }

  const exact = input.contentHash
    ? input.existingAssets.find((asset) => asset.contentHash && asset.contentHash === input.contentHash)
    : null;
  if (exact) {
    return createDecision("DUPLICATE", "duplicate_exact", {
      relationKind: "DUPLICATE_OF",
      toVisualAssetId: exact.assetId,
      description: "exact duplicate via sha256",
    });
  }

  const near = input.perceptualHash
    ? input.existingAssets.find((asset) => asset.perceptualHash && hammingDistance(asset.perceptualHash, input.perceptualHash!) <= NEAR_DUPLICATE_HAMMING_THRESHOLD)
    : null;
  if (near) {
    return createDecision("DUPLICATE", "duplicate_near", {
      relationKind: "DUPLICATE_OF",
      toVisualAssetId: near.assetId,
      description: "near duplicate via dHash<=6",
    });
  }

  const hasCaption = Boolean(input.caption?.trim());
  const nearbyText = input.nearbyText?.trim() ?? "";
  const hasContext = hasCaption || nearbyText.length >= 24;
  if (input.signals.includes("review_small_context") || !hasContext) {
    return createDecision("REVIEW", "needs_context_review");
  }

  return createDecision("SELECTED", "selected_contextual_match");
}

export function unavailableVisualDecision(code: string): VisualFilterDecision {
  return createDecision("UNAVAILABLE", `unavailable_${normalizeReasonCode(code)}`);
}

export function buildLinkOnlyVisualDraft(input: LinkOnlyVisualDraftInput): LinkOnlyVisualDraft {
  if (!EXTERNAL_LINK_ONLY_RIGHTS.has(input.rightsStatus)) {
    throw new Error("link_only_requires_external_rights_state");
  }

  const now = input.now ?? new Date().toISOString();
  const nextId = input.idFactory ?? uuid;
  const assetId = nextId();
  const versionId = nextId();
  const relationId = input.decision.duplicateOf ? nextId() : null;

  return {
    persistBytes: false,
    asset: {
      id: assetId,
      parentSourceId: input.parentSourceId,
      parentVersionId: input.parentVersionId,
      originKind: input.originKind,
      sourceUrl: input.sourceUrl,
      pageNumber: input.pageNumber ?? null,
      figureLabel: input.figureLabel,
      bboxJson: input.bboxJson ?? null,
      candidateKey: input.candidateKey,
      caption: input.caption,
      nearbyText: input.nearbyText,
      assetRole: "REFERENCE",
      visualKind: "OTHER",
      selectionStatus: input.decision.selectionStatus,
      selectionReason: input.decision.selectionReason,
      rightsStatus: input.rightsStatus,
      rightsBasis: input.rightsBasis,
      rightsReviewedAt: now,
      assignmentStatus: "ASSIGNED",
      storageState: "LINK_ONLY",
      pendingStorageState: null,
      processingStatus: "READY",
      lastError: null,
      contentHash: input.contentHash,
      perceptualHash: input.perceptualHash ?? null,
      perceptualHashMethod: input.perceptualHash ? "IMAGES_RGBA_DHASH_V1" : null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    originalVersion: {
      id: versionId,
      visualAssetId: assetId,
      version: 1,
      variant: "ORIGINAL",
      r2Key: null,
      mimeType: input.contentType,
      width: null,
      height: null,
      byteSize: input.byteSize,
      contentHash: input.contentHash,
      parentAssetVersionId: null,
    },
    provenance: {
      sourceUrl: input.sourceUrl,
      finalUrl: input.finalUrl,
      caption: input.caption,
      nearbyText: input.nearbyText,
      contentHash: input.contentHash,
      selectionReason: input.decision.selectionReason,
      ruleVersion: input.decision.ruleVersion,
    },
    relations: input.decision.duplicateOf && relationId
      ? [{
        id: relationId,
        relationKind: "DUPLICATE_OF",
        createdBy: "SYSTEM",
        description: input.decision.duplicateOf.description,
        toVisualAssetId: input.decision.duplicateOf.toVisualAssetId,
        relatedSourceId: null,
        relatedThreadId: null,
        createdAt: now,
      }]
      : [],
  };
}

function createDecision(
  selectionStatus: VisualSelectionStatus,
  reasonCode: string,
  duplicateOf: DuplicateRelationDecision | null = null,
): VisualFilterDecision {
  return {
    selectionStatus,
    selectionReason: `${VISUAL_FILTER_RULE_VERSION}:${reasonCode}`,
    ruleVersion: VISUAL_FILTER_RULE_VERSION,
    duplicateOf,
  };
}

function normalizeReasonCode(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY;

  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    const a = parseInt(left[index]!, 16);
    const b = parseInt(right[index]!, 16);
    if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
    distance += bitCount(a ^ b);
  }
  return distance;
}

function bitCount(value: number): number {
  let count = 0;
  let current = value;
  while (current > 0) {
    count += current & 1;
    current >>= 1;
  }
  return count;
}
