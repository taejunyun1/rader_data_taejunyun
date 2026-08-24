import { useEffect, useRef, type ReactNode } from "react";

interface SplitWorkspaceProps {
  index: ReactNode;
  reading: ReactNode;
  readingKey?: string | null;
  mobilePane?: "index" | "reading";
}

export default function SplitWorkspace({ index, reading, readingKey = null, mobilePane = "index" }: SplitWorkspaceProps) {
  const readingRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (readingRef.current) readingRef.current.scrollTop = 0;
  }, [readingKey]);

  return (
    <div className="split-workspace" data-testid="split-workspace" data-mobile-pane={mobilePane}>
      <section className="split-workspace__index" role="region" aria-label="자료 목록">{index}</section>
      <main ref={readingRef} className="split-workspace__reading" aria-label="자료 읽기">{reading}</main>
    </div>
  );
}
