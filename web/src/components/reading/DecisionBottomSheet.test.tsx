import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import DecisionBottomSheet from "./DecisionBottomSheet";
import type { ReadingDocument } from "./types";

const document: ReadingDocument = {
  id: "source-1",
  title: "읽을 자료 제목",
  originalTitle: "Original source title",
  byline: "저자 · 2026 · RSS",
  provenance: "발견 후보 · 검색어 사진",
  access: { kind: "DIRECT", label: "원문 링크", actionLabel: "원문에서 읽기", href: "https://example.com/read" },
  summary: null,
  fragments: [],
  questions: [],
  keywords: [],
};

describe("DecisionBottomSheet", () => {
  it("shows the judgment actions as a dialog and closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<DecisionBottomSheet document={document} onClose={onClose} onAction={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "읽은 뒤 판단" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "발전시키기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "보관하기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "관찰하기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "제외하기" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reports the selected action and disables all actions while pending", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();

    render(<DecisionBottomSheet document={document} pending onAction={onAction} onClose={vi.fn()} />);

    const develop = screen.getByRole("button", { name: "발전시키기" });
    expect(develop).toBeDisabled();
    expect(screen.getByRole("button", { name: "보관하기" })).toBeDisabled();

    await user.click(develop);

    expect(onAction).not.toHaveBeenCalled();
  });

  it("focuses an existing judgment's change action, then the first decision action, and returns focus on close", async () => {
    const user = userEvent.setup();

    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>판단 열기</button>
        <DecisionBottomSheet
          document={document}
          decisionStatus="watch"
          open={open}
          onAction={vi.fn()}
          onClose={() => setOpen(false)}
        />
      </>;
    }

    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "판단 열기" });
    await user.click(trigger);

    const change = screen.getByRole("button", { name: "판단 변경" });
    expect(change).toHaveFocus();

    await user.click(change);
    expect(screen.getByRole("button", { name: "발전시키기" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(trigger).toHaveFocus();
  });

  it("keeps new-judgment initial focus on the first action", () => {
    render(<DecisionBottomSheet document={document} onClose={vi.fn()} onAction={vi.fn()} />);

    expect(screen.getByRole("button", { name: "발전시키기" })).toHaveFocus();
  });

  it("does not steal focus again when the open sheet rerenders", () => {
    const { rerender } = render(
      <DecisionBottomSheet document={document} onClose={() => undefined} onAction={() => undefined} />,
    );
    const close = screen.getByRole("button", { name: "닫기" });
    close.focus();

    rerender(
      <DecisionBottomSheet document={document} onClose={() => undefined} onAction={() => undefined} />,
    );

    expect(close).toHaveFocus();
  });

  it("traps focus inside the dialog and hides the background while open", async () => {
    const user = userEvent.setup();

    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>판단 열기</button>
        <DecisionBottomSheet
          document={document}
          open={open}
          onAction={vi.fn()}
          onClose={() => setOpen(false)}
        />
      </>;
    }

    const { container } = render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "판단 열기" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "읽은 뒤 판단" });
    expect(container).toHaveAttribute("aria-hidden", "true");
    expect(container).toHaveAttribute("inert");
    expect(within(dialog).getByRole("button", { name: "발전시키기" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "닫기" })).toHaveFocus();

    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "제외하기" })).toHaveFocus();

    await user.tab();
    expect(within(dialog).getByRole("button", { name: "닫기" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "읽은 뒤 판단" })).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute("aria-hidden");
    expect(container).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });
});
