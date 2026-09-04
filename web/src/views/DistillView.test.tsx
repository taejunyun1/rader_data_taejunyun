import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DistillView from "./DistillView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [{ id: "session-1", redistillOf: null, costUsd: 0.01, createdAt: "2026-08-21T00:00:00Z" }] })));
    if (url === "/api/distill/budget") return Promise.resolve(new Response(JSON.stringify({ usedPct: 12, budgetUsd: 10, blocked: false, warn: false })));
    if (url === "/api/distill/sessions/session-1") return Promise.resolve(new Response(JSON.stringify({ session: { id: "session-1", redistillOf: null, modelVersion: "model", promptVersion: "prompt", costUsd: 0.01, createdAt: "2026-08-21T00:00:00Z", sourcesUsed: [], output: { keywords: ["사진"], thoughts_fragments: [], questions: ["무엇을 읽을까"], read_next: [], research_gaps: [], research_directions: ["관찰하기"], artwork_directions: [], small_experiment: "작게 시험하기" }, critic: null, counter: null }, readingQueue: [{ id: "queue-1", title: "다음 자료", author: "저자", priority: "MUST", whyRead: "연결된 이유", relatedQuestion: null, sourceUrl: "https://example.com/read", openalexId: null, verified: 0 }], researchGaps: [] })));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }));
});

describe("DistillView", () => {
  it("places reading queue before research actions and gates unverified imports", async () => {
    render(<DistillView />);
    expect(await screen.findByRole("heading", { name: "착즙" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /다음 읽기/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "확인 필요" })).toBeDisabled();
    expect(screen.getByText("연결된 이유")).toBeInTheDocument();
  });

  it("keeps the counter enabled by default and exposes the counter result", async () => {
    render(<DistillView />);
    expect(await screen.findByRole("switch", { name: "반대 관점 포함" })).toBeChecked();
    expect(screen.getByText("반대 관점 결과가 없습니다.")).toBeInTheDocument();
  });

  it("explains when the latest Distill exceeds the homepage public limits", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [{ id: "session-latest", redistillOf: null, costUsd: 0.01, createdAt: "2026-09-03T00:00:00Z" }] })));
      if (url === "/api/distill/budget") return Promise.resolve(new Response(JSON.stringify({ usedPct: 12, budgetUsd: 10, blocked: false, warn: false })));
      if (url === "/api/distill/sessions/session-latest") return Promise.resolve(new Response(JSON.stringify({ session: { id: "session-latest", redistillOf: null, modelVersion: "model", promptVersion: "prompt", costUsd: 0.01, createdAt: "2026-09-03T00:00:00Z", sourcesUsed: [], output: { keywords: ["1", "2", "3", "4", "5", "6", "7", "8"], thoughts_fragments: ["1", "2", "3", "4", "5", "6"], questions: [], read_next: [], research_gaps: [], research_directions: [], artwork_directions: [] }, critic: null, counter: null, homepagePublicationState: "NONE" }, readingQueue: [], researchGaps: [] })));
      if (url === "/api/distill/homepage-publication") return Promise.resolve(new Response(JSON.stringify({ currentRevision: "r0", current: { state: "NONE" }, latestPublishable: null, ledgerReconcilePending: false }), { headers: { "Content-Type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });
    render(<DistillView />);
    expect(await screen.findByText("최신 Distill이 홈페이지 공개 상한을 초과했습니다 (키워드 8/7 · 생각의 조각 6/5).")) .toBeInTheDocument();
  });

  it("sends the counter choice with a new distill run", async () => {
    render(<DistillView />);
    await screen.findByRole("heading", { name: "착즙" });
    await userEvent.click(screen.getByRole("switch", { name: "반대 관점 포함" }));
    await userEvent.click(screen.getByRole("button", { name: "새로 착즙하기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/distill/run", expect.objectContaining({ body: JSON.stringify({ includeCounter: false }) })));
  });

  it("renders research-gap details by output index, including long and duplicate gap text", async () => {
    const fetchMock = vi.mocked(fetch);
    const longGap = "연구 공백 ".padEnd(801, "가");
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [{ id: "session-gaps", redistillOf: null, costUsd: 0.01, createdAt: "2026-09-03T00:00:00Z" }] })));
      if (url === "/api/distill/budget") return Promise.resolve(new Response(JSON.stringify({ usedPct: 12, budgetUsd: 10, blocked: false, warn: false })));
      if (url === "/api/distill/sessions/session-gaps") return Promise.resolve(new Response(JSON.stringify({
        session: {
          id: "session-gaps", redistillOf: null, modelVersion: "model", promptVersion: "prompt", costUsd: 0.01, createdAt: "2026-09-03T00:00:00Z", sourcesUsed: [],
          output: {
            keywords: [], thoughts_fragments: [], questions: [], read_next: [], research_gaps: [{ gap: longGap, kind: "under-evidenced" }, { gap: longGap, kind: "under-researched" }], research_directions: [], artwork_directions: [],
            details: {
              thoughts: [], questions: [],
              researchGaps: [
                { summaryIndex: 0, diagnosis: "진단-0", researchMethod: "방법-0", sourceIds: [] },
                { summaryIndex: 1, diagnosis: "진단-1", researchMethod: "방법-1", sourceIds: [] },
              ],
              researchDirections: [], artworkDirections: [],
            },
          }, critic: null, counter: null, homepagePublicationState: "NONE",
        },
        readingQueue: [],
        researchGaps: [
          { id: "gap-db-1", gap: longGap.slice(0, 800), kind: "under-researched" },
          { id: "gap-db-0", gap: longGap.slice(0, 800), kind: "under-evidenced" },
        ],
        detailSources: [],
      })));
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });

    render(<DistillView />);

    expect(await screen.findAllByText(longGap)).toHaveLength(2);
    const toggles = await screen.findAllByRole("button", { name: "근거와 맥락 보기" });
    expect(toggles).toHaveLength(2);
    await userEvent.click(toggles[0]!);
    expect(screen.getByText("진단-0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "근거와 맥락 보기" }));
    expect(screen.getByText("진단-1")).toBeInTheDocument();
  });

  it("previews and publishes a completed Distill to the homepage", async () => {
    const fetchMock = vi.mocked(fetch);
    const content = { displayTitle: "현재 연구", keywords: ["사진"], thoughts: [], questions: ["무엇을 읽을까"], researchDirections: [], artworkDirections: [], researchMaterials: [] };
    const currentStatus = { currentRevision: "r0", current: { state: "NONE" }, latestPublishable: { sessionId: "session-1", distilledAt: "2026-08-21T00:00:00.000Z", contentHash: "a".repeat(64) }, ledgerReconcilePending: false };
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [{ id: "session-1", redistillOf: null, costUsd: 0.01, createdAt: "2026-08-21T00:00:00Z", homepagePublicationState: "NONE" }] })));
      if (url === "/api/distill/budget") return Promise.resolve(new Response(JSON.stringify({ usedPct: 12, budgetUsd: 10, blocked: false, warn: false })));
      if (url === "/api/distill/sessions/session-1") return Promise.resolve(new Response(JSON.stringify({ session: { id: "session-1", redistillOf: null, modelVersion: "model", promptVersion: "prompt", costUsd: 0.01, createdAt: "2026-08-21T00:00:00.000Z", sourcesUsed: [], output: { keywords: ["사진"], thoughts_fragments: [], questions: ["무엇을 읽을까"], read_next: [], research_gaps: [], research_directions: [], artwork_directions: [] }, critic: null, counter: null, homepagePublicationState: "NONE" }, readingQueue: [], researchGaps: [] })));
      if (url === "/api/distill/homepage-publication") return Promise.resolve(new Response(JSON.stringify(currentStatus), { headers: { "Content-Type": "application/json" } }));
      if (url.endsWith("/homepage-preview")) return Promise.resolve(new Response(JSON.stringify({ sessionId: "session-1", distilledAt: "2026-08-21T00:00:00.000Z", contentHash: "a".repeat(64), currentRevision: "r0", changed: true, excludedResearchMaterialCount: 0, content, privateReview: { warnings: [], overall: null } }), { headers: { "Content-Type": "application/json" } }));
      if (url.endsWith("/csrf")) return Promise.resolve(new Response(JSON.stringify({ token: "csrf", expiresAt: "2026-08-21T00:15:00.000Z" }), { headers: { "Content-Type": "application/json" } }));
      if (url.endsWith("/homepage-publish")) return Promise.resolve(new Response(JSON.stringify({ ok: true, publication: { schemaVersion: 1, kind: "CURRENT_RESEARCH", source: "research-radar", state: "EXPLORING", publicationId: "p1", distilledAt: "2026-08-21T00:00:00.000Z", publishedAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", contentHash: "a".repeat(64), content }, currentRevision: "r1", idempotent: false, ledgerReconcilePending: false }), { headers: { "Content-Type": "application/json" } }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });
    render(<DistillView />);
    await screen.findByRole("button", { name: "홈페이지로 내보내기" });
    await userEvent.click(screen.getByRole("button", { name: "홈페이지로 내보내기" }));
    expect(await screen.findByRole("dialog", { name: "현재 연구" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "공개 반영" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/distill/sessions/session-1/homepage-publish", expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedContentHash: "a".repeat(64), expectedCurrentRevision: "r0" }) })));
    expect(await screen.findByText("홈페이지에 현재 연구를 반영했습니다.")).toBeInTheDocument();
  });
});
