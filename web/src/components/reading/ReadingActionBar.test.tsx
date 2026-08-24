import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ReadingActionBar from "./ReadingActionBar";

describe("ReadingActionBar", () => {
  it("opens judgment explicitly and supports mobile list return", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onOpenDecision = vi.fn();

    render(<ReadingActionBar statusLabel={null} onBack={onBack} onOpenDecision={onOpenDecision} />);

    await user.click(screen.getByRole("button", { name: "판단하기" }));
    expect(onOpenDecision).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "목록으로" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("uses judgment-change copy when a status exists", () => {
    render(<ReadingActionBar statusLabel="관찰 중" onBack={vi.fn()} onOpenDecision={vi.fn()} />);

    expect(screen.getByText("현재 판단 · 관찰 중")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "판단 변경" })).toBeInTheDocument();
  });
});
