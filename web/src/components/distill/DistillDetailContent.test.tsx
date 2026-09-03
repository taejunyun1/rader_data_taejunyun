import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DistillDetailContent from "./DistillDetailContent";

describe("DistillDetailContent", () => {
  it("shows rationale fields and distinguishes unavailable sources", () => {
    render(<DistillDetailContent
      fields={[
        { label: "근거", value: "자료의 제작 조건을 연결했다." },
        { label: "다음 확인", value: "촬영 로그를 대조한다." },
      ]}
      sourceIds={["source-1", "source-deleted"]}
      sourceRefs={[
        { id: "source-1", title: "현재 자료", available: true },
        { id: "source-deleted", title: "보존된 자료", available: false },
      ]}
      onOpenReservoir={vi.fn()}
    />);

    expect(screen.getByText("자료의 제작 조건을 연결했다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "현재 자료" })).toBeInTheDocument();
    expect(screen.getByText("보존된 자료 (현재 저장소에서 찾을 수 없음)")).toBeInTheDocument();
  });
});
