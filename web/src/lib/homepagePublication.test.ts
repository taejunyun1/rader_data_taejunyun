import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomepagePublicationStatusResponse } from "@radar/shared";
import { deriveHomepagePublicationAction, fetchHomepagePreview, fetchHomepagePublicationStatus, homepagePublicationErrorMessage, publishHomepagePreview } from "./homepagePublication";

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
const status: HomepagePublicationStatusResponse = { currentRevision: "r0", current: { state: "NONE" }, latestPublishable: { sessionId: "s1", distilledAt: "2026-09-03T00:00:00.000Z", contentHash: "a".repeat(64) }, ledgerReconcilePending: false };
const preview = { sessionId: "s1", distilledAt: "2026-09-03T00:00:00.000Z", contentHash: "a".repeat(64), currentRevision: "r0", changed: true, excludedResearchMaterialCount: 0, content: { displayTitle: "현재 연구", keywords: ["빛"], thoughts: [], questions: [], researchDirections: [], artworkDirections: [], researchMaterials: [] }, privateReview: { warnings: [], overall: null } };

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe("homepage publication client", () => {
  it("uses no-store same-origin GETs and validates status", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(json(status));
    await expect(fetchHomepagePublicationStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith("/api/distill/homepage-publication", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  });

  it("encodes session IDs for preview requests", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(json(preview));
    await fetchHomepagePreview("session/one");
    expect(fetchMock).toHaveBeenCalledWith("/api/distill/sessions/session%2Fone/homepage-preview", expect.anything());
  });

  it("gets a fresh CSRF token immediately before a publish POST", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(json({ token: "csrf-1", expiresAt: "2026-09-03T00:15:00.000Z" })).mockResolvedValueOnce(json({ ok: true, publication: { schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING", publicationId: "p1", distilledAt: "2026-09-03T00:00:00.000Z", publishedAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z", contentHash: "a".repeat(64), content: preview.content }, currentRevision: "r1", idempotent: false, ledgerReconcilePending: false }));
    await publishHomepagePreview("s1", { expectedContentHash: preview.contentHash, expectedCurrentRevision: preview.currentRevision });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/distill/homepage-publication/csrf");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/distill/sessions/s1/homepage-publish");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ expectedContentHash: preview.contentHash, expectedCurrentRevision: "r0" }) });
  });

  it("maps malformed success responses to invalid_response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html>nope</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await expect(fetchHomepagePublicationStatus()).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("prioritizes purge/current state over latest publishable", () => {
    expect(deriveHomepagePublicationAction({ sessionId: "s1", sessionState: "PURGED", status })).toEqual({ kind: "PURGED", enabled: false, label: "공개 삭제됨 · 새 Distill 필요" });
    expect(deriveHomepagePublicationAction({ sessionId: "s1", sessionState: "NONE", status: { ...status, current: { state: "PUBLISHED", publicationId: "p", distillSessionId: "s1", contentHash: "b".repeat(64), publishedAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" } } }).kind).toBe("CURRENT");
  });

  it("never exposes raw server error codes", () => {
    expect(homepagePublicationErrorMessage("publish", "publication_in_progress")).toContain("다른 공개 작업");
    expect(homepagePublicationErrorMessage("status", "unknown_code")).toBe("홈페이지 공개 상태를 확인하지 못했습니다.");
  });
});
