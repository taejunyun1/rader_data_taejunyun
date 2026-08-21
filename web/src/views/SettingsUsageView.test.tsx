import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsView from "./SettingsView";
import UsageView from "./UsageView";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/settings/params") return Promise.resolve(new Response(JSON.stringify({ familiarity: 0.5, researchDepth: 0.5, divergence: 0.5, counterStrength: 0.5, technicalPhotographic: 0.5 })));
    return Promise.resolve(new Response(JSON.stringify({ month: "2026-08", budgetUsd: 10, usedUsd: 8.5, usedPct: 85, calls: 4, inputTokens: 1000, outputTokens: 500, distillSessions: 1, distillAvgCost: 0.2, byPurpose: [{ purpose: "distill", calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.2 }], byModel: [], daily: [], months: [] })));
  }));
});

describe("SettingsView", () => { it("uses Korean labels for research controls", async () => { render(<SettingsView />); expect(await screen.findByRole("heading", { name: "연구 성향" })).toBeInTheDocument(); expect(screen.getByText("깊은 연구")).toBeInTheDocument(); }); });
describe("UsageView", () => { it("shows warning state at the budget threshold", async () => { render(<UsageView />); expect(await screen.findByText(/월 한도의 80% 이상/)).toBeInTheDocument(); expect(screen.getByRole("heading", { name: "사용량" })).toBeInTheDocument(); }); });
