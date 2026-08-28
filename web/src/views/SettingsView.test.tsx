import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/params") return Promise.resolve(new Response(JSON.stringify({ familiarity: 0.5, researchDepth: 0.5, divergence: 0.5, counterStrength: 0.5, technicalPhotographic: 0.5 })));
    if (url === "/api/settings/models") return Promise.resolve(new Response(JSON.stringify({ roles: { baseModel: "base", reviewModel: "review" }, models: [{ id: "base", pricingKnown: true }, { id: "review", pricingKnown: true }] })));
    if (url === "/api/reservoir/duplicates?status=PENDING") return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "candidate-1", leftTitle: "원본 자료 A", rightTitle: "원본 자료 B", decision: "REVIEW", score: 0.8, reasons: ["제목 일치"], status: "PENDING" }] })));
    if (url === "/api/reservoir/refresh" && init?.method === "POST") return Promise.resolve(new Response(JSON.stringify({ runId: "preview-1", mode: "PREVIEW", autoMergeCount: 3, reviewCount: 2 }), { status: 202 }));
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }));
});

describe("SettingsView repository maintenance", () => {
  it("shows preview counts and enables apply after a repository preview", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(screen.getByRole("button", { name: "저장소 점검 미리보기" }));

    expect(await screen.findByText("자동 병합 3건 · 검토 2건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "정리 적용" })).toBeEnabled();
  });

  it("lists pending duplicate candidates with review actions", async () => {
    render(<SettingsView />);

    expect(await screen.findByText("원본 자료 A")).toBeInTheDocument();
    expect(screen.getByText("원본 자료 B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "병합" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "별도 유지" })).toBeEnabled();
  });

  it("resolves a pending candidate as separate", async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    await user.click(await screen.findByRole("button", { name: "별도 유지" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/reservoir/duplicates/candidate-1", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "SEPARATE" }) })));
    expect(screen.queryByText("원본 자료 A")).not.toBeInTheDocument();
  });
});
