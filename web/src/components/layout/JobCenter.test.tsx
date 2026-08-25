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

  it("opens an acquisition result by source id without an analysis id", async () => {
    const onResult = vi.fn();
    const resultRef = { view: "RESERVOIR", sourceId: "source-1", acquisition: true } as const;
    render(<JobCenter
      jobs={[job({ kind: "SOURCE_ACQUISITION", status: "SUCCEEDED", resultRef })]}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
      onResult={onResult}
    />);

    expect(screen.getByText("원문 수집 · 완료")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "결과 보기" }));
    expect(onResult).toHaveBeenCalledWith(resultRef);
  });

  it("distinguishes web extraction, pdf extraction, and review-needed extraction jobs", async () => {
    const onResult = vi.fn();
    render(<JobCenter
      jobs={[
        job({
          id: "job-web",
          kind: "VISUAL_EXTRACTION",
          result: {
            sourceId: "source-1",
            extractionRunId: "run-web",
            counts: { selected: 2, review: 0, filtered: 3, unavailable: 0 },
            diagnostics: { sourceKind: "HTML" },
          },
          resultRef: { view: "VISUAL", sourceId: "source-1", extractionRunId: "run-web" },
        }),
        job({
          id: "job-pdf",
          kind: "VISUAL_EXTRACTION",
          result: {
            sourceId: "source-2",
            extractionRunId: "run-pdf",
            counts: { selected: 1, review: 0, filtered: 1, unavailable: 0 },
            diagnostics: { sourceKind: "PDF" },
          },
          resultRef: { view: "VISUAL", sourceId: "source-2", extractionRunId: "run-pdf" },
        }),
        job({
          id: "job-review",
          kind: "VISUAL_EXTRACTION",
          result: {
            sourceId: "source-3",
            extractionRunId: "run-review",
            counts: { selected: 1, review: 2, filtered: 0, unavailable: 0 },
            diagnostics: { sourceKind: "HTML" },
          },
          resultRef: { view: "VISUAL", sourceId: "source-3", extractionRunId: "run-review" },
        }),
      ]}
      onDismiss={vi.fn()}
      onRetry={vi.fn()}
      onResult={onResult}
    />);

    expect(screen.getByText("웹 이미지 추출 · 완료")).toBeInTheDocument();
    expect(screen.getByText("PDF 이미지 추출 · 완료")).toBeInTheDocument();
    expect(screen.getByText("일부 이미지 확인 필요 · 완료")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "결과 보기" })[0]);
    expect(onResult).toHaveBeenCalledWith({ view: "RESERVOIR", sourceId: "source-1", acquisition: true });
  });
});
