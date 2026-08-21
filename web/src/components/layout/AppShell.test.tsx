import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AppShell from "./AppShell";

describe("AppShell", () => {
  it("renders Korean navigation and changes views", async () => {
    const onNavigate = vi.fn();
    render(<AppShell view="RADAR" onNavigate={onNavigate} usage={null} tasks={[]}><p>본문</p></AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "발견" }));
    expect(onNavigate).toHaveBeenCalledWith("DISCOVER");
    expect(screen.getByRole("button", { name: "레이더" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps usage and settings in the utility area", () => {
    render(<AppShell view="RADAR" onNavigate={vi.fn()} usage={{ usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false }} tasks={[]}><p>본문</p></AppShell>);
    expect(screen.getByText("AI 사용량")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "설정" })).toBeInTheDocument();
  });
});
