import type {
  DiscoveryDecisionReason,
  DiscoveryLane,
  DiscoveryQuerySource,
} from "./discovery";
import type { DiscoveryFieldSignalRunDiagnostics } from "./fieldSignals";

export type DiscoveryProviderName = "openalex" | "arxiv" | "rss";
export type DiscoveryQueryPlanStatus = "READY" | "UNSUPPORTED";
export type DiscoveryProviderOutcomeStatus = "OK" | "TIMEOUT" | "HTTP_ERROR" | "PARSE_ERROR";

export interface DiscoveryQueryPlanItem {
  sourceQuery: string;
  providerQuery: string | null;
  lane: DiscoveryLane;
  querySource: DiscoveryQuerySource;
  concepts: string[];
  providers: Array<"openalex" | "arxiv">;
  status: DiscoveryQueryPlanStatus;
  selected: boolean;
  unsupportedReason: "NO_MAPPABLE_CONCEPT" | null;
}

export interface DiscoveryProviderResult<T> {
  status: DiscoveryProviderOutcomeStatus;
  items: T[];
  errorCode: string | null;
  elapsedMs: number;
}

export interface DiscoveryProviderStats {
  requests: number;
  succeededRequests: number;
  failedRequests: number;
  received: number;
  missingAccess: number;
  rejected: number;
  duplicate: number;
  quotaExcluded: number;
  selected: number;
  errorCodes: string[];
}

export interface DiscoveryRunDiagnostics {
  plannedQueries: number;
  readyQueries: number;
  executedQueries: number;
  unsupportedQueries: number;
  providers: Record<DiscoveryProviderName, DiscoveryProviderStats>;
  rejectedByReason: Partial<Record<DiscoveryDecisionReason, number>>;
  existingReclassified: number;
  incomplete: boolean;
}

export interface DiscoveryRunResult {
  collected: number;
  fieldSignalsCollected: number;
  keptExisting: number;
  queries: string[];
  diagnostics: DiscoveryRunDiagnostics;
  fieldSignalDiagnostics: DiscoveryFieldSignalRunDiagnostics;
}

function emptyProviderStats(): DiscoveryProviderStats {
  return {
    requests: 0,
    succeededRequests: 0,
    failedRequests: 0,
    received: 0,
    missingAccess: 0,
    rejected: 0,
    duplicate: 0,
    quotaExcluded: 0,
    selected: 0,
    errorCodes: [],
  };
}

export function createEmptyDiscoveryDiagnostics(): DiscoveryRunDiagnostics {
  return {
    plannedQueries: 0,
    readyQueries: 0,
    executedQueries: 0,
    unsupportedQueries: 0,
    providers: {
      openalex: emptyProviderStats(),
      arxiv: emptyProviderStats(),
      rss: emptyProviderStats(),
    },
    rejectedByReason: {},
    existingReclassified: 0,
    incomplete: false,
  };
}
