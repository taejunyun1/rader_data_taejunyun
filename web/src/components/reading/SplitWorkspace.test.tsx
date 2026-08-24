import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SplitWorkspace from "./SplitWorkspace";

describe("SplitWorkspace", () => {
  it("exposes pane state for responsive layout", () => {
    render(<SplitWorkspace index={<p>목록</p>} reading={<p>문서</p>} mobilePane="reading" readingKey="a" />);

    expect(screen.getByTestId("split-workspace")).toHaveAttribute("data-mobile-pane", "reading");
    expect(screen.getByRole("region", { name: "자료 목록" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "자료 읽기" })).toBeInTheDocument();
  });

  it("resets only the reading pane when the selected document changes", () => {
    const { rerender } = render(
      <SplitWorkspace index={<p>목록</p>} reading={<p>문서 A</p>} mobilePane="reading" readingKey="a" />,
    );
    const reading = screen.getByRole("region", { name: "자료 읽기" });
    reading.scrollTop = 320;

    rerender(<SplitWorkspace index={<p>목록</p>} reading={<p>문서 B</p>} mobilePane="reading" readingKey="b" />);

    expect(reading.scrollTop).toBe(0);
  });
});
