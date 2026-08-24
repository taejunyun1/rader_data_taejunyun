import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

interface SplitWorkspaceProps {
  index: ReactNode;
  reading: ReactNode;
  readingKey?: string | null;
  mobilePane?: "index" | "reading";
}

export default function SplitWorkspace({ index, reading, readingKey = null, mobilePane = "index" }: SplitWorkspaceProps) {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const readingRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    let frameId = 0;
    const updateAvailableHeight = () => {
      frameId = 0;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const top = workspace.getBoundingClientRect().top;
      workspace.style.setProperty("--split-workspace-available-height", `${Math.max(0, viewportHeight - Math.max(0, top))}px`);
    };
    const scheduleUpdate = () => {
      if (!frameId) frameId = window.requestAnimationFrame(updateAvailableHeight);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(workspace);
    if (workspace.parentElement) observer?.observe(workspace.parentElement);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.visualViewport?.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.visualViewport?.removeEventListener("resize", scheduleUpdate);
      if (frameId) window.cancelAnimationFrame(frameId);
    };
  }, []);

  useEffect(() => {
    if (readingRef.current) readingRef.current.scrollTop = 0;
  }, [readingKey]);

  return (
    <div ref={workspaceRef} className="split-workspace" data-testid="split-workspace" data-mobile-pane={mobilePane}>
      <section className="split-workspace__index" role="region" aria-label="자료 목록">{index}</section>
      <section ref={readingRef} className="split-workspace__reading" role="region" aria-label="자료 읽기">{reading}</section>
    </div>
  );
}
