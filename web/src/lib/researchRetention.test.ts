import { describe, expect, it } from "vitest";
import { isNextResearchMarkAction } from "@radar/shared";

describe("next research retention", () => {
  it("treats keep and develop as marks for the next research", () => {
    expect(isNextResearchMarkAction("keep")).toBe(true);
    expect(isNextResearchMarkAction("develop")).toBe(true);
    expect(isNextResearchMarkAction("watch")).toBe(false);
    expect(isNextResearchMarkAction("ignore")).toBe(false);
  });
});
