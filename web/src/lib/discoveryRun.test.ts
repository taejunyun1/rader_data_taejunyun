import { describe, expect, it } from "vitest";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";

describe("discovery run contracts", () => {
  it("creates zeroed stats for every provider", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();

    expect(diagnostics.plannedQueries).toBe(0);
    expect(diagnostics.providers.openalex).toMatchObject({
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
    });
    expect(diagnostics.providers.arxiv.requests).toBe(0);
    expect(diagnostics.providers.rss.requests).toBe(0);
    expect(diagnostics.rejectedByReason).toEqual({});
    expect(diagnostics.incomplete).toBe(false);
  });
});
