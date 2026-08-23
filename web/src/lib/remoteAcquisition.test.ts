import { describe, expect, it } from "vitest";
import type { ResearchJobKind, ResearchJobResultRef } from "@radar/shared/discovery";

describe("remote acquisition job metadata", () => {
  it("exposes the source acquisition job kind", () => {
    const kind: ResearchJobKind = "SOURCE_ACQUISITION";

    expect(kind).toBe("SOURCE_ACQUISITION");
  });

  it("uses the reservoir acquisition result ref", () => {
    const resultRef: ResearchJobResultRef = {
      view: "RESERVOIR",
      sourceId: "source-123",
      acquisition: true,
    };

    expect(resultRef).toEqual({
      view: "RESERVOIR",
      sourceId: "source-123",
      acquisition: true,
    });
  });
});
