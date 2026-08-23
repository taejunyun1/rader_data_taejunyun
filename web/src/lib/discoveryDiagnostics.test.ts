import { describe, expect, it } from "vitest";
import { createEmptyDiscoveryDiagnostics } from "@radar/shared/discoveryRun";
import { recordCandidateOutcome, recordProviderResult } from "../../../worker/src/discovery/diagnostics";

describe("discovery diagnostics", () => {
  it("records one terminal outcome per candidate", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();
    recordProviderResult(diagnostics, "openalex", { status: "OK", items: [{ id: "1" }], errorCode: null, elapsedMs: 4 });
    recordCandidateOutcome(diagnostics, "openalex", { kind: "REJECTED", reason: "NO_RESEARCH_ANCHOR" });

    expect(diagnostics.providers.openalex.received).toBe(1);
    expect(diagnostics.providers.openalex.rejected).toBe(1);
    expect(diagnostics.rejectedByReason.NO_RESEARCH_ANCHOR).toBe(1);
    expect(diagnostics.providers.openalex.selected).toBe(0);
  });

  it("marks a run incomplete only when a failed request coexists with a successful provider", () => {
    const diagnostics = createEmptyDiscoveryDiagnostics();
    recordProviderResult(diagnostics, "openalex", { status: "TIMEOUT", items: [], errorCode: "TIMEOUT", elapsedMs: 4 });
    expect(diagnostics.incomplete).toBe(false);

    recordProviderResult(diagnostics, "arxiv", { status: "OK", items: [], errorCode: null, elapsedMs: 4 });
    expect(diagnostics.incomplete).toBe(true);
  });
});
