import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResearchJob } from "@radar/shared/discovery";
import AppShell from "./AppShell";

describe("AppShell", () => {
  it("renders Korean navigation and changes views", async () => {
    const onNavigate = vi.fn();
    render(<AppShell view="RADAR" onNavigate={onNavigate} usage={null} jobs={[]} onDismissJob={vi.fn()} onRetryJob={vi.fn()} onResult={vi.fn()}><p>본문</p></AppShell>);
    await userEvent.click(screen.getByRole("button", { name: "발견" }));
    expect(onNavigate).toHaveBeenCalledWith("DISCOVER");
    expect(screen.getByRole("button", { name: "레이더" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps usage and settings in the utility area", () => {
    render(<AppShell view="RADAR" onNavigate={vi.fn()} usage={{ usedUsd: 1, budgetUsd: 10, usedPct: 10, blocked: false }} jobs={[]} onDismissJob={vi.fn()} onRetryJob={vi.fn()} onResult={vi.fn()}><p>본문</p></AppShell>);
    expect(screen.getByText("AI 사용량")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "설정" })).toBeInTheDocument();
  });

  it("keeps active work visible in the navigation", () => {
    const activeJob = { id: "job-1", kind: "DISTILL_RUN", status: "RUNNING", progress: 42 } as ResearchJob;
    render(<AppShell view="RADAR" onNavigate={vi.fn()} usage={null} jobs={[activeJob]} onDismissJob={vi.fn()} onRetryJob={vi.fn()} onResult={vi.fn()}><p>본문</p></AppShell>);
    expect(screen.getByRole("button", { name: "착즙 42%" })).toBeInTheDocument();
  });
});
