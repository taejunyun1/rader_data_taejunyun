import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DiscoverView from "./DiscoverView";

const candidate = { id: "candidate-1", openalexId: "https://openalex.org/W1", title: "자료 후보", authors: "저자", year: 2026, relevanceScore: 0.82, status: "CANDIDATE", queryUsed: "사진 연구", provider: "openalex", externalUrl: "https://doi.org/10.0000/example" };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/discover/candidates/candidate-1/keep" && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ ok: true, status: "KEPT", sourceId: "source-1" })));
    if (url.startsWith("/api/discover/candidates")) return Promise.resolve(new Response(JSON.stringify({ items: [candidate] })));
    if (url === "/api/discover/queries") return Promise.resolve(new Response(JSON.stringify({ queries: [] })));
    if (url === "/api/discover/feeds") return Promise.resolve(new Response(JSON.stringify({ feeds: [] })));
    if (url === "/api/settings/homepage") return Promise.resolve(new Response(JSON.stringify({ projects: [] })));
    if (url === "/api/signals" && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }));
});

describe("DiscoverView", () => {
  it("keeps actual access links visible while reading a candidate", async () => {
    render(<DiscoverView onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole("option", { name: /자료 후보/ }));
    expect(screen.getAllByRole("link", { name: /서지·접근 정보/ })[1]).toHaveAttribute("href", "https://doi.org/10.0000/example");
    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.getByText("분석 내용 없음")).toBeInTheDocument();
  });

  it("maps 발전시키기 to keep plus a develop signal", async () => {
    const onNavigate = vi.fn();
    render(<DiscoverView onNavigate={onNavigate} />);
    await userEvent.click(await screen.findByRole("option", { name: /자료 후보/ }));
    await userEvent.click(screen.getByRole("button", { name: "발전시키기" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/signals", expect.objectContaining({ method: "POST", body: JSON.stringify({ sourceId: "source-1", action: "develop" }) })));
    expect(onNavigate).toHaveBeenCalledWith("RESERVOIR");
  });
});
