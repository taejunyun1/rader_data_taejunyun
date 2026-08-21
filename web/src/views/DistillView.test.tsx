import { render, screen } from "@testing-library/react";
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
});
