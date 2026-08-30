import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RadarView from "./RadarView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/radar/stats")) return Promise.resolve(new Response(JSON.stringify({ stats: { newSources: 2, newKeywords: [{ keyword: "사진", count: 2 }], newQuestions: ["무엇을 읽을까"], signalCounts: { develop: 1 }, topKeptSources: [], distillRuns: 1, gapsRaised: 1, readingQueueSize: 1, kindBreakdown: { PAPER_ACADEMIC: 2 } } })));
    if (url === "/api/reservoir/topics") return Promise.resolve(new Response(JSON.stringify({ topics: [{ topic: "사진", count: 2 }] })));
    if (url === "/api/radar/snapshots") return Promise.resolve(new Response(JSON.stringify({ snapshots: [{ period: "WEEKLY", synthesis: { period: "WEEKLY", narrative: "저장된 서사", sections: [{ heading: "rising keywords — what is growing this week", items: [{ observation: "반복되는 흐름" }] }, { heading: "new connections between distant materials", items: [{ observation: "서로 먼 자료의 연결" }] }], biasWatch: [{ observation: "한 주제에 집중됨", recommendation: "반대 자료도 읽기" }], costUsd: 0.01 } }] })));
    if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [] })));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }));
});

describe("RadarView", () => {
  it("shows quantitative facts before interpretation without repeated sections", async () => {
    const onNavigate = vi.fn();
    render(<RadarView onNavigate={onNavigate} />);
    const overview = await screen.findByRole("region", { name: "이번 주 정량 요약" });
    const narrative = await screen.findByText("저장된 서사");
    expect(overview.compareDocumentPosition(narrative) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: "관심 신호" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "상승 신호" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "이번 주 새로 떠오른 키워드" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "멀리 있는 자료 사이의 새 연결" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 후보 확인 발견으로 이동 →" })).toBeInTheDocument();
  });

  it("does not show another period's saved narrative", async () => {
    const onNavigate = vi.fn();
    render(<RadarView onNavigate={onNavigate} />);
    await screen.findByText("저장된 서사");
    await userEvent.click(screen.getByRole("button", { name: "이번 달" }));
    expect(screen.queryByText("저장된 서사")).not.toBeInTheDocument();
  });

  it("skips a distill session whose sources were deleted from the reservoir", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/radar/stats")) return Promise.resolve(new Response(JSON.stringify({ stats: { newSources: 0, newKeywords: [], newQuestions: [], signalCounts: {}, topKeptSources: [], distillRuns: 0, gapsRaised: 0, readingQueueSize: 1, kindBreakdown: {} } })));
      if (url === "/api/reservoir/topics") return Promise.resolve(new Response(JSON.stringify({ topics: [] })));
      if (url === "/api/radar/snapshots") return Promise.resolve(new Response(JSON.stringify({ snapshots: [] })));
      if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [
        { id: "deleted-session", createdAt: "2026-08-30", sourceCount: 1, activeSourceCount: 0 },
        { id: "active-session", createdAt: "2026-08-29", sourceCount: 1, activeSourceCount: 1 },
      ] })));
      if (url === "/api/distill/sessions/active-session") return Promise.resolve(new Response(JSON.stringify({ readingQueue: [{ id: "active-queue", title: "활성 자료 읽기", verified: 1, sourceUrl: "https://example.com/active", whyRead: "현재 저장소 자료와 연결됨" }] })));
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }));

    render(<RadarView onNavigate={vi.fn()} />);

    expect(await screen.findByText("활성 자료 읽기 ↗")).toBeInTheDocument();
  });
});
