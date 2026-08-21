import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
