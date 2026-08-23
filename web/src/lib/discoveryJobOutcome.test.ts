import { describe, expect, it } from "vitest";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";
import { discoveryCombinedJobOutcome, discoveryJobOutcome } from "../../../worker/src/discovery/diagnostics";

describe("discovery job outcome", () => {
  it("treats one successful empty provider as a successful zero-result run", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();
    diagnostics.providers.openalex.requests = 1;
    diagnostics.providers.openalex.succeededRequests = 1;
    expect(discoveryJobOutcome(diagnostics, false)).toBe("SUCCEEDED");
  });

  it("treats all provider failures as unavailable", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();
    diagnostics.executedQueries = 1;
    diagnostics.providers.openalex.requests = 1;
    diagnostics.providers.openalex.failedRequests = 1;
    expect(discoveryJobOutcome(diagnostics, false)).toBe("FAILED");
  });

  it("blocks only when every planned query is unsupported and no feed can run", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();
    diagnostics.plannedQueries = 2;
    diagnostics.unsupportedQueries = 2;
    expect(discoveryJobOutcome(diagnostics, false)).toBe("BLOCKED");
  });

  it("succeeds when reading providers fail but a field-signal source succeeds", () => {
    expect(discoveryCombinedJobOutcome(
      "FAILED",
      {
        sources: {
          icp: {
            requests: 1,
            succeededRequests: 1,
            failedRequests: 0,
            received: 2,
            rejected: 0,
            stale: 0,
            expired: 0,
            missingUrl: 0,
            duplicate: 0,
            quotaExcluded: 0,
            selected: 2,
            errorCodes: [],
          },
        },
        rejectedByReason: {},
        incomplete: false,
      },
    )).toBe("SUCCEEDED");
  });

  it("fails only when reading and field-signal providers are both unavailable", () => {
    expect(discoveryCombinedJobOutcome(
      "FAILED",
      {
        sources: {
          icp: {
            requests: 1,
            succeededRequests: 0,
            failedRequests: 1,
            received: 0,
            rejected: 0,
            stale: 0,
            expired: 0,
            missingUrl: 0,
            duplicate: 0,
            quotaExcluded: 0,
            selected: 0,
            errorCodes: ["TIMEOUT"],
          },
        },
        rejectedByReason: {},
        incomplete: true,
      },
    )).toBe("FAILED");
  });
});
