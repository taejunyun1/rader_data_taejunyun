import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ReservoirView from "./ReservoirView";

const sourceDetail = { source: { id: "source-1", title: "자료 A", authors: "저자", kind: "PAPER_ACADEMIC", reliability: "PRIMARY", origin: "upload", year: 2025, canonicalUrl: "https://example.com/paper", provenanceClass: "SOURCE", createdAt: "2026-08-21", markedForNextResearch: 1 }, analysis: { summary: "시스템이 정리한 내용", keywords: ["사진"], questions: ["어떻게 읽을까"], important_fragments: ["원문 문장"] }, keywords: [], questions: [], fragments: [], versions: [], signals: [] };

beforeEach(() => {
  let requestedWatching = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/reservoir" || url.startsWith("/api/reservoir?")) {
      const decisionStatus = url.includes("decision=watching") ? "watch" : null;
      requestedWatching = decisionStatus === "watch";
      return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "source-1", title: "자료 A", kind: "PAPER_ACADEMIC", reliability: "PRIMARY", status: "indexed", origin: "upload", year: 2025, canonicalUrl: "https://example.com/paper", createdAt: "2026-08-21", topics: "[\"사진\"]", keywordCount: 1, signalCount: 0, markedForNextResearch: 1, decisionStatus }] })));
    }
    if (url === "/api/reservoir/topics") return Promise.resolve(new Response(JSON.stringify({ topics: [] })));
    if (url === "/api/reservoir/source-1") return Promise.resolve(new Response(JSON.stringify(requestedWatching ? { ...sourceDetail, source: { ...sourceDetail.source, decisionStatus: "watch" } } : sourceDetail)));
    if (url === "/api/signals" && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    return Promise.resolve(new Response(JSON.stringify({ items: [] })));
  }));
});

describe("ReservoirView", () => {
  it("keeps the index visible while reading a source", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("option", { name: /자료 A/ }));
    expect(screen.getByRole("dialog", { name: "읽은 뒤 판단" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "저장소 자료" })).toBeInTheDocument();
    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.getByText("원문에서 추출한 문장")).toBeInTheDocument();
    expect(screen.getAllByText(/다음 리서치/).length).toBeGreaterThan(0);
  });

  it("records a develop signal", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("option", { name: /자료 A/ }));
    await userEvent.click(screen.getByRole("button", { name: "발전시키기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/signals", expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceId: "source-1", action: "develop" }) })));
  });

  it("replaces decision buttons with the current status badge", async () => {
    render(<ReservoirView />);
    await userEvent.click(await screen.findByRole("button", { name: "관찰 중" }));
    await userEvent.click(await screen.findByRole("option", { name: /자료 A/ }));
    expect(screen.getByText("현재 판단")).toBeInTheDocument();
    expect(screen.getAllByText("관찰 중").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: "판단 변경" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "보관하기" })).not.toBeInTheDocument();
  });
});
