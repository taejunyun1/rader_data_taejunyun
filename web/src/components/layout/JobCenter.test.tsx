import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResearchJob } from "@radar/shared/discovery";
import JobCenter from "./JobCenter";

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    id: "job-1",
    workflowInstanceId: "workflow-1",
    kind: "RADAR_SYNTHESIS",
    status: "SUCCEEDED",
    progress: 100,
    message: "완료",
    input: { period: "WEEKLY" },
    result: null,
    resultRef: { view: "RADAR", period: "WEEKLY" },
    errorCode: null,
    error: null,
    retryOf: null,
    requestedBy: "local",
    dedupeKey: "radar",
    dismissedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    startedAt: "2026-08-22T00:00:01.000Z",
    finishedAt: "2026-08-22T00:00:02.000Z",
    updatedAt: "2026-08-22T00:00:02.000Z",
    ...overrides,
  };
}

describe("JobCenter", () => {
  it("opens the completed result and can dismiss it", async () => {
    const onResult = vi.fn();
    const onDismiss = vi.fn();
    render(<JobCenter jobs={[job()]} onDismiss={onDismiss} onRetry={vi.fn()} onResult={onResult} />);
    expect(screen.getByText("레이더 생성 · 완료")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "결과 보기" }));
    await userEvent.click(screen.getByRole("button", { name: "레이더 생성 닫기" }));
    expect(onResult).toHaveBeenCalledWith({ view: "RADAR", period: "WEEKLY" });
    expect(onDismiss).toHaveBeenCalledWith("job-1");
  });

  it("offers retry for blocked work", async () => {
    const onRetry = vi.fn();
    render(<JobCenter jobs={[job({ status: "BLOCKED", resultRef: null, error: "월 한도" })]} onDismiss={vi.fn()} onRetry={onRetry} onResult={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "다시 실행" }));
    expect(onRetry).toHaveBeenCalledWith("job-1");
  });
});
