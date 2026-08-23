import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import UsageView from "./UsageView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/settings/params") return Promise.resolve(new Response(JSON.stringify({ familiarity: 0.5, researchDepth: 0.5, divergence: 0.5, counterStrength: 0.5, technicalPhotographic: 0.5 })));
    if (String(input) === "/api/settings/models") return Promise.resolve(new Response(JSON.stringify({
      roles: { baseModel: "gpt-5-mini", reviewModel: "gpt-5.4-mini" },
      models: [
        { id: "gpt-5-mini", created: 1, shutdownDate: null, pricingKnown: true },
        { id: "gpt-5.4-mini", created: 2, shutdownDate: null, pricingKnown: true },
      ],
    })));
    return Promise.resolve(new Response(JSON.stringify({ month: "2026-08", budgetUsd: 10, usedUsd: 8.5, usedPct: 85, calls: 4, inputTokens: 1000, outputTokens: 500, distillSessions: 1, distillAvgCost: 0.2, byPurpose: [{ purpose: "distill", calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.2 }], byModel: [], daily: [], months: [] })));
  }));
});

describe("SettingsView", () => {
  it("uses Korean labels for research controls", async () => {
    render(<SettingsView />);
    expect(await screen.findByRole("heading", { name: "연구 성향" })).toBeInTheDocument();
    expect(screen.getByText("깊은 연구")).toBeInTheDocument();
  });

  it("shows two selectable AI model roles", async () => {
    render(<SettingsView />);
    expect(await screen.findByLabelText("기본 모델")).toHaveValue("gpt-5-mini");
    expect(screen.getByLabelText("상위 통합·반론 검증 모델")).toHaveValue("gpt-5.4-mini");
  });

  it("runs bounded discovery backfill and explains that prior versions are preserved", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/settings/params") return Promise.resolve(new Response(JSON.stringify({ familiarity: 0.5, researchDepth: 0.5, divergence: 0.5, counterStrength: 0.5, technicalPhotographic: 0.5 })));
      if (String(input) === "/api/settings/models") return Promise.resolve(new Response(JSON.stringify({ roles: { baseModel: "gpt-5-mini", reviewModel: "gpt-5.4-mini" }, models: [] })));
      if (String(input) === "/api/settings/backfill-discovery") return Promise.resolve(new Response(JSON.stringify({ selected: 3, enqueued: 2, skipped: 1, errors: 0 })));
      return Promise.reject(new Error(`unexpected request: ${String(input)}`));
    });
    render(<SettingsView />);

    expect(await screen.findByText(/이전 버전은 그대로 보존/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "발견 자료 원문 다시 가져오기" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/backfill-discovery", { method: "POST" });
    expect(await screen.findByText("발견 자료 3개 중 2개의 원문 수집을 시작했습니다. 건너뜀 1개, 오류 0개.")).toBeInTheDocument();
  });
});
describe("UsageView", () => { it("shows warning state at the budget threshold", async () => { render(<UsageView />); expect(await screen.findByText(/월 한도의 80% 이상/)).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "사용량" })).toBeInTheDocument(); }); });
