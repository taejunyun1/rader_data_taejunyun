import { describe, expect, it } from "vitest";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";
import { discoveryJobOutcome } from "../../../worker/src/discovery/diagnostics";

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
});
