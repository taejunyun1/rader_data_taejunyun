import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ReadingPane from "./ReadingPane";

describe("ReadingPane", () => {
  it("shows an original title only beneath a translated title", () => {
    render(<ReadingPane document={{ id: "translated", title: "번역된 제목", originalTitle: "Original title", byline: "저자", provenance: "원자료", access: { kind: "UNKNOWN", label: "접근 경로 확인 필요", actionLabel: "출처 정보 보기", href: null }, summary: null, fragments: [], questions: [], keywords: [] }} />);
    expect(screen.getByText("원문 제목")).toBeInTheDocument();
    expect(screen.getByText("Original title")).toBeInTheDocument();
  });

  it("separates source material from system interpretation", () => {
    render(<ReadingPane document={{ id: "1", title: "자료", byline: "저자", provenance: "저장소 원자료", access: { kind: "DIRECT", label: "원문 링크", actionLabel: "원문에서 읽기", href: "https://example.com" }, summary: "해석", fragments: ["원문 문장"], questions: ["질문"], keywords: ["사진"] }} />);
    expect(screen.getByText("시스템 해석")).toBeInTheDocument();
    expect(screen.getByText("원문에서 추출한 문장")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /원문 링크/ })).toHaveAttribute("href", "https://example.com");
  });

  it("does not render a fake reading link", () => {
    render(<ReadingPane document={{ id: "2", title: "후보", byline: "출처 미상", provenance: "발견 후보 메타데이터", access: { kind: "UNKNOWN", label: "접근 경로 확인 필요", actionLabel: "출처 정보 보기", href: null }, summary: null, fragments: [], questions: [], keywords: [] }} />);
    expect(screen.queryByRole("link", { name: /원문/ })).not.toBeInTheDocument();
    expect(screen.getByText("분석 내용 없음")).toBeInTheDocument();
  });
});
