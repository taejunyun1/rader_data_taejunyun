import { describe, expect, it } from "vitest";
import { homepageReadingSourceProvenance } from "../../../worker/src/homepage/reading";

describe("homepage reading provenance", () => {
  it("treats curated homepage summaries as metadata rather than acquired full text", () => {
    expect(homepageReadingSourceProvenance()).toEqual({
      textScope: "METADATA_ONLY",
      extractionMethod: "DISCOVERY_METADATA",
    });
  });
});
