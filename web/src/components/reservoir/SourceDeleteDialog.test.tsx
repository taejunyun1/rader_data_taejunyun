import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SourceDeleteDialog from "./SourceDeleteDialog";

const baseProps = {
  open: true,
  sourceId: "source-1",
  title: "자료 A",
  mergeRole: "NONE" as const,
  mergeMemberCount: 1,
  pending: false,
  error: "",
  onClose: vi.fn(),
  onConfirm: vi.fn(),
};

describe("SourceDeleteDialog", () => {
  it("requires the exact title and submits it", async () => {
    const onConfirm = vi.fn();
    render(<SourceDeleteDialog {...baseProps} onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog", { name: "자료 영구 삭제" });
    const confirm = within(dialog).getByRole("button", { name: "영구 삭제" });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A ");
    expect(confirm).toBeDisabled();
    await userEvent.clear(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"));
    await userEvent.type(within(dialog).getByLabelText("확인을 위해 자료 제목 입력"), "자료 A");
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("자료 A");
  });

  it("explains canonical reassignment and member-only deletion", () => {
    const { rerender } = render(
      <SourceDeleteDialog {...baseProps} mergeRole="CANONICAL" mergeMemberCount={3} />,
    );
    expect(screen.getByText(/남은 2개 자료 중 새 대표를 선정/)).toBeInTheDocument();
    rerender(<SourceDeleteDialog {...baseProps} mergeRole="MEMBER" mergeMemberCount={3} />);
    expect(screen.getByText(/이 자료만 병합 그룹에서 제거/)).toBeInTheDocument();
  });

  it("focuses the title input, closes on Escape, and locks controls while pending", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<SourceDeleteDialog {...baseProps} onClose={onClose} />);
    const input = screen.getByLabelText("확인을 위해 자료 제목 입력");
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<SourceDeleteDialog {...baseProps} pending onClose={onClose} />);
    expect(screen.getByLabelText("확인을 위해 자료 제목 입력")).toBeDisabled();
    expect(screen.getByRole("button", { name: "삭제 중…" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a retryable error without closing", () => {
    render(<SourceDeleteDialog {...baseProps} error="원본 저장소 정리에 실패했습니다. 다시 시도해 주세요." />);
    expect(screen.getByRole("alert")).toHaveTextContent("원본 저장소 정리에 실패했습니다.");
  });
});
