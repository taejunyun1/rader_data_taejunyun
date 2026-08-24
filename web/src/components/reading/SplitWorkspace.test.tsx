import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SplitWorkspace from "./SplitWorkspace";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("keeps the fallback pane height until the workspace enters the viewport", () => {
    let top = 700;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      x: 0, y: top, top, left: 0, right: 0, bottom: top + 200, width: 100, height: 200, toJSON: () => ({}),
    }));
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });

    render(<SplitWorkspace index={<p>목록</p>} reading={<p>문서</p>} />);
    act(() => { frames.shift()?.(0); });
    const workspace = screen.getByTestId("split-workspace");
    expect(workspace.style.getPropertyValue("--split-workspace-available-height")).toBe("");

    top = 180;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      frames.shift()?.(0);
    });
    expect(workspace.style.getPropertyValue("--split-workspace-available-height")).toBe("420px");
  });
});
