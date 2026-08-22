import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CounterSection from "./CounterSection";

describe("CounterSection", () => {
  it("shows the direct opposition before counter directions", () => {
    render(<CounterSection
      enabled
      counter={{
        dominant_claim: "자동화가 지식 생산의 중심이다",
        opposing_thesis: "수작업만이 지식 생산의 근거다",
        incompatibility: "두 명제는 같은 연구 기준으로 동시에 유지될 수 없습니다.",
        axes: [{ from: "자동화", to: "수작업", rationale: "판단의 주체를 뒤집습니다." }],
        suggestions: [],
        validation: { status: "verified", issues: [] },
      }}
    />);

    expect(screen.getByText("자동화가 지식 생산의 중심이다")).toBeInTheDocument();
    expect(screen.getByText("수작업만이 지식 생산의 근거다")).toBeInTheDocument();
    expect(screen.getByText("자동화 → 수작업")).toBeInTheDocument();
  });

  it("does not present an unverified counter as confirmed", () => {
    render(<CounterSection enabled counter={{
      dominant_claim: "현재 주장",
      opposing_thesis: "반대 주장",
      axes: [],
      suggestions: [],
      validation: { status: "unverified", issues: ["정합성 부족"] },
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent("충분히 검증하지 못했습니다");
  });

  it("records when the counter was intentionally disabled", () => {
    render(<CounterSection enabled={false} counter={null} />);
    expect(screen.getByText("이번 착즙에서는 반대 관점을 제외했습니다.")).toBeInTheDocument();
  });
});
