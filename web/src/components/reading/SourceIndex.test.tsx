import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SourceIndex from "./SourceIndex";

const items = [
  { id: "a", title: "자료 A", meta: "학술 논문 · 2026", tags: ["사진"], access: { kind: "DIRECT" as const, label: "무료 원문 확인", actionLabel: "원문 읽기", href: "https://example.com/a" } },
  { id: "b", title: "자료 B", meta: "웹 자료 · 2025", tags: [], access: { kind: "UNKNOWN" as const, label: "접근 여부 미확인", actionLabel: "출처 확인", href: null } },
];

describe("SourceIndex", () => {
  it("renders a standard list without a link nested inside the selection button", () => {
    render(<SourceIndex title="저장소 자료" items={items} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("list", { name: "저장소 자료" })).toBeInTheDocument();
    const first = screen.getByRole("button", { name: /자료 A/ });
    expect(first.querySelector("a")).toBeNull();
    expect(first).toHaveAttribute("tabindex", "0");
  });

  it("moves selection and focus with arrow keys", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SourceIndex title="저장소 자료" items={items} selectedId={null} onSelect={onSelect} />);
    const first = screen.getByRole("button", { name: /자료 A/ });
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(screen.getByRole("button", { name: /자료 B/ })).toHaveFocus();
  });
});
