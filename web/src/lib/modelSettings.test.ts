import { describe, expect, it } from "vitest";
import { filterSelectableModels, parseModelRoles, type ModelOption } from "./modelSettings";
import { modelTierForDeepStage } from "../../../worker/src/analysis/deepProfiles";

describe("model settings helpers", () => {
  it("keeps text models and filters non-text model families", () => {
    expect(filterSelectableModels([
      { id: "gpt-5-mini", created: 1, shutdownDate: null },
      { id: "gpt-realtime-2", created: 2, shutdownDate: null },
      { id: "gpt-image-2", created: 3, shutdownDate: null },
      { id: "text-embedding-3-small", created: 4, shutdownDate: null },
      { id: "gpt-5.6-terra", created: 5, shutdownDate: null },
    ] as ModelOption[]).map((model) => model.id)).toEqual(["gpt-5.6-terra", "gpt-5-mini"]);
  });

  it("falls back to environment roles when saved settings are malformed", () => {
    expect(parseModelRoles("not-json", { baseModel: "gpt-5-mini", reviewModel: "gpt-5.4-mini" })).toEqual({
      baseModel: "gpt-5-mini",
      reviewModel: "gpt-5.4-mini",
    });
  });

  it("uses the base role for chunk reading and the review role for final synthesis", () => {
    expect(modelTierForDeepStage("chunk")).toBe("high");
    expect(modelTierForDeepStage("synthesis")).toBe("deep");
  });
});
