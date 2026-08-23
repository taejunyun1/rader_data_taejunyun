import type {
  DiscoveryDecisionReason,
  DiscoveryFieldSignalRunDiagnostics,
  DiscoveryProviderName,
  DiscoveryProviderResult,
  DiscoveryRunDiagnostics,
} from "@radar/shared";

export type CandidateOutcome =
  | { kind: "MISSING_ACCESS"; reason: "PAYWALLED" | "ACCESS_UNKNOWN" }
  | { kind: "REJECTED"; reason: Exclude<DiscoveryDecisionReason, "RELEVANT" | "PAYWALLED" | "ACCESS_UNKNOWN"> }
  | { kind: "DUPLICATE" }
  | { kind: "QUOTA_EXCLUDED" }
  | { kind: "SELECTED" };

function providerTotals(diagnostics: DiscoveryRunDiagnostics): { requests: number; succeeded: number; failed: number } {
  return Object.values(diagnostics.providers).reduce(
    (totals, stats) => ({
      requests: totals.requests + stats.requests,
      succeeded: totals.succeeded + stats.succeededRequests,
      failed: totals.failed + stats.failedRequests,
    }),
    { requests: 0, succeeded: 0, failed: 0 },
  );
}

export function recordProviderResult<T>(
  diagnostics: DiscoveryRunDiagnostics,
  provider: DiscoveryProviderName,
  result: DiscoveryProviderResult<T>,
): void {
  const stats = diagnostics.providers[provider];
  stats.requests += 1;
  stats.received += result.items.length;
  if (result.status === "OK") {
    stats.succeededRequests += 1;
  } else {
    stats.failedRequests += 1;
    if (result.errorCode && !stats.errorCodes.includes(result.errorCode) && stats.errorCodes.length < 5) {
      stats.errorCodes.push(result.errorCode);
    }
  }
  const totals = providerTotals(diagnostics);
  diagnostics.incomplete = totals.failed > 0 && totals.succeeded > 0;
}

export function recordCandidateOutcome(
  diagnostics: DiscoveryRunDiagnostics,
  provider: DiscoveryProviderName,
  outcome: CandidateOutcome,
): void {
  const stats = diagnostics.providers[provider];
  switch (outcome.kind) {
    case "MISSING_ACCESS":
      stats.missingAccess += 1;
      diagnostics.rejectedByReason[outcome.reason] = (diagnostics.rejectedByReason[outcome.reason] ?? 0) + 1;
      break;
    case "REJECTED":
      stats.rejected += 1;
      diagnostics.rejectedByReason[outcome.reason] = (diagnostics.rejectedByReason[outcome.reason] ?? 0) + 1;
      break;
    case "DUPLICATE":
      stats.duplicate += 1;
      break;
    case "QUOTA_EXCLUDED":
      stats.quotaExcluded += 1;
      break;
    case "SELECTED":
      stats.selected += 1;
      break;
  }
}

export function discoveryJobOutcome(
  diagnostics: DiscoveryRunDiagnostics,
  hasActiveRss: boolean,
): "SUCCEEDED" | "FAILED" | "BLOCKED" {
  const totals = providerTotals(diagnostics);
  const allPlannedItemsUnsupported = diagnostics.plannedQueries > 0
    && diagnostics.unsupportedQueries === diagnostics.plannedQueries;
  if (!hasActiveRss && diagnostics.executedQueries === 0 && allPlannedItemsUnsupported) return "BLOCKED";
  if (totals.requests > 0 && totals.failed === totals.requests) return "FAILED";
  diagnostics.incomplete = totals.failed > 0 && totals.succeeded > 0;
  return "SUCCEEDED";
}

export function discoveryCombinedJobOutcome(
  readingOutcome: "SUCCEEDED" | "FAILED" | "BLOCKED",
  fieldSignals: DiscoveryFieldSignalRunDiagnostics,
): "SUCCEEDED" | "FAILED" | "BLOCKED" {
  if (readingOutcome === "SUCCEEDED") return "SUCCEEDED";
  if (readingOutcome === "BLOCKED") return "BLOCKED";
  const signalSucceeded = Object.values(fieldSignals.sources).some((source) => source.succeededRequests > 0);
  if (signalSucceeded) return "SUCCEEDED";
  return readingOutcome;
}

export function discoveryCombinedJobFailure(
  outcome: "SUCCEEDED" | "FAILED" | "BLOCKED",
):
  | null
  | { outcome: "FAILED"; errorCode: "discovery_providers_unavailable"; errorMessage: "discovery_providers_unavailable" }
  | { outcome: "BLOCKED"; errorCode: "discovery_queries_unusable"; errorMessage: "검색어를 짧은 개념어로 수정하세요." } {
  if (outcome === "FAILED") {
    return {
      outcome,
      errorCode: "discovery_providers_unavailable",
      errorMessage: "discovery_providers_unavailable",
    };
  }
  if (outcome === "BLOCKED") {
    return {
      outcome,
      errorCode: "discovery_queries_unusable",
      errorMessage: "검색어를 짧은 개념어로 수정하세요.",
    };
  }
  return null;
}
