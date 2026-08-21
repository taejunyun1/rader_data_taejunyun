import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RadarView from "./RadarView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/radar/stats")) return Promise.resolve(new Response(JSON.stringify({ stats: { newSources: 2, newKeywords: [{ keyword: "사진", count: 2 }], newQuestions: ["무엇을 읽을까"], signalCounts: { develop: 1 }, topKeptSources: [], distillRuns: 1, gapsRaised: 1, readingQueueSize: 1, kindBreakdown: { PAPER_ACADEMIC: 2 } } })));
    if (url === "/api/reservoir/topics") return Promise.resolve(new Response(JSON.stringify({ topics: [{ topic: "사진", count: 2 }] })));
    if (url === "/api/radar/snapshots") return Promise.resolve(new Response(JSON.stringify({ snapshots: [{ period: "WEEKLY", synthesis: { period: "WEEKLY", narrative: "저장된 서사", sections: [], biasWatch: [], costUsd: 0.01 } }] })));
    if (url === "/api/distill/sessions") return Promise.resolve(new Response(JSON.stringify({ sessions: [] })));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }));
});

describe("RadarView", () => {
  it("shows the dashboard reading order and Korean navigation actions", async () => {
    const onNavigate = vi.fn();
    render(<RadarView onNavigate={onNavigate} />);
    expect(await screen.findByText("상승 신호")).toBeInTheDocument();
    expect(screen.getByText("남은 질문")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 후보 확인 발견으로 이동 →" })).toBeInTheDocument();
    expect(await screen.findByText("저장된 서사")).toBeInTheDocument();
  });

  it("does not show another period's saved narrative", async () => {
    const onNavigate = vi.fn();
    render(<RadarView onNavigate={onNavigate} />);
    await screen.findByText("저장된 서사");
    await userEvent.click(screen.getByRole("button", { name: "이번 달" }));
    expect(screen.queryByText("저장된 서사")).not.toBeInTheDocument();
  });
});
