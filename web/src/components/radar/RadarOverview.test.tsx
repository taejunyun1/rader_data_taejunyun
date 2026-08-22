import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RadarOverview from "./RadarOverview";
import type { RadarStats } from "../../lib/radarPresentation";

const stats: RadarStats = {
  newSources: 103,
  newKeywords: [
    { keyword: "photography", count: 25 },
    { keyword: "machine-vision", count: 18 },
  ],
  newQuestions: [],
  signalCounts: { develop: 5, keep: 3, watch: 2, ignore: 1, import: 113, view: 33 },
  topKeptSources: [],
  distillRuns: 7,
  gapsRaised: 19,
  readingQueueSize: 31,
  kindBreakdown: { NOTE: 51, WEB: 36, PERSONAL_WORK: 10, PAPER_ACADEMIC: 4 },
};

describe("RadarOverview", () => {
  it("shows period metrics before three quantitative groups", () => {
    render(<RadarOverview stats={stats} periodLabel="이번 주" />);
    const overview = screen.getByRole("region", { name: "이번 주 정량 요약" });
    expect(within(overview).getByText("103")).toBeInTheDocument();
    expect(within(overview).getByRole("heading", { name: "관심 신호" })).toBeInTheDocument();
    expect(within(overview).getByRole("heading", { name: "판단 분포" })).toBeInTheDocument();
    expect(within(overview).getByRole("heading", { name: "저장소 구성" })).toBeInTheDocument();
  });

  it("shows Korean keyword labels with the original below", () => {
    render(<RadarOverview stats={stats} periodLabel="이번 주" />);
    expect(screen.getByText("사진")).toBeInTheDocument();
    expect(screen.getByText("photography")).toBeInTheDocument();
  });

  it("does not count import and view as decisions", () => {
    render(<RadarOverview stats={stats} periodLabel="이번 주" />);
    const decisions = screen.getByLabelText("이번 주 판단 분포");
    expect(within(decisions).queryByText("가져오기")).not.toBeInTheDocument();
    expect(within(decisions).queryByText("열람")).not.toBeInTheDocument();
    expect(within(decisions).getByText("발전")).toBeInTheDocument();
  });

  it("labels all-time composition and gives empty charts readable messages", () => {
    render(<RadarOverview stats={{ ...stats, newKeywords: [], signalCounts: {}, kindBreakdown: {} }} periodLabel="이번 달" />);
    expect(screen.getByText("숫자는 선택한 기간 기준이며, 저장소 구성만 전체 누적입니다.")).toBeInTheDocument();
    expect(screen.getByText("이 기간에 새롭게 집계된 키워드가 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("이 기간에 남긴 판단이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("저장소에 집계된 자료가 없습니다.")).toBeInTheDocument();
  });
});
