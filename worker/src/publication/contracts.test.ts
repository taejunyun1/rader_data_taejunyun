import { describe, expect, it } from "vitest";
import { validateCurrentResearchPayload, validateCurrentResearchStorageWrapper, type CurrentResearchPayload } from "@radar/shared";

const content = { displayTitle: "현재 연구", keywords: ["빛"], thoughts: [], questions: [], researchDirections: [], artworkDirections: [], researchMaterials: [] };
const validExploring: CurrentResearchPayload = {
  schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING", publicationId: "pub-1",
  distilledAt: "2026-09-03T00:00:00.000Z", publishedAt: "2026-09-03T00:10:00.000Z", updatedAt: "2026-09-03T00:10:00.000Z",
  contentHash: "83658fcd9e3c6f3557020c301d2b66327444e49b3eae48a7bbceef447c847170", content,
};
const validWithdrawn: CurrentResearchPayload = {
  schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "WITHDRAWN",
  withdrawnPublicationId: "pub-1", withdrawnContentHash: "a".repeat(64), withdrawnAt: "2026-09-03T01:00:00.000Z",
};

describe("strict public payload contract", () => {
  it("accepts exact exploring and withdrawn variants", () => {
    expect(validateCurrentResearchPayload(validExploring)).toEqual(validExploring);
    expect(validateCurrentResearchPayload(validWithdrawn)).toEqual(validWithdrawn);
    expect(validateCurrentResearchPayload({ ...validWithdrawn, withdrawnPublicationId: null, withdrawnContentHash: "a".repeat(64) })).toBeNull();
  });

  it("rejects unknown/private keys and malformed identity fields", () => {
    expect(validateCurrentResearchPayload({ ...validExploring, critic: {} })).toBeNull();
    expect(validateCurrentResearchPayload({ ...validExploring, modelVersion: "x" })).toBeNull();
    expect(validateCurrentResearchPayload({ ...validExploring, contentHash: "A".repeat(64) })).toBeNull();
    expect(validateCurrentResearchPayload({ ...validExploring, publicationId: "" })).toBeNull();
    expect(validateCurrentResearchPayload({ ...validExploring, distilledAt: "not-date" })).toBeNull();
  });

  it("enforces content limits and strict material URLs", () => {
    expect(validateCurrentResearchPayload({ ...validExploring, content: { ...content, keywords: ["x".repeat(81)] } })).toBeNull();
    expect(validateCurrentResearchPayload({ ...validExploring, content: { ...content, researchMaterials: [{ title: "x", author: null, year: null, url: "http://localhost/x" }] } })).toBeNull();
    expect(validateCurrentResearchPayload({ ...validExploring, content: { ...content, researchMaterials: [{ title: "x", author: null, year: null, url: "https://example.com/a" }] } })).toEqual(expect.objectContaining({ state: "EXPLORING" }));
    for (const url of ["https://example.local/x", "https://8.8.8.8/x", "https://10.0.0.1/x", "https://172.16.0.1/x", "https://192.168.1.1/x", "https://127.0.0.1/x", "https://[2001:4860:4860::8888]/x", "https://[::1]/x", "https://[fc00::1]/x", "https://[fe80::1]/x"]) {
      expect(validateCurrentResearchPayload({ ...validExploring, content: { ...content, researchMaterials: [{ title: "x", author: null, year: null, url }] } })).toBeNull();
    }
  });

  it("rejects invalid calendar timestamps and serialized payloads over 64 KiB", () => {
    expect(validateCurrentResearchPayload({ ...validExploring, distilledAt: "2026-02-31T00:00:00.000Z" })).toBeNull();
    const oversized = { ...validExploring, content: { ...content, thoughts: ["x".repeat(70_000)] } };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(64 * 1024);
    expect(validateCurrentResearchPayload(oversized)).toBeNull();
    expect(validateCurrentResearchStorageWrapper({ storageRevision: "00000000-0000-4000-8000-000000000000", payload: oversized })).toBeNull();
  });

  it("pins the canonical UTF-8 bytes and SHA-256 digest independently", async () => {
    const literal = '{"content":{"artworkDirections":[],"displayTitle":"현재 연구","keywords":["빛"],"questions":[],"researchDirections":[],"researchMaterials":[],"thoughts":[]},"distilledAt":"2026-09-03T00:00:00.000Z"}';
    const bytes = new TextEncoder().encode(literal);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(new TextDecoder().decode(bytes)).toBe(literal);
    expect(digest).toBe("83658fcd9e3c6f3557020c301d2b66327444e49b3eae48a7bbceef447c847170");
  });
});
