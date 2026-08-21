import type { ReactNode } from "react";

interface SplitWorkspaceProps {
  index: ReactNode;
  reading: ReactNode;
  decision: ReactNode;
}

export default function SplitWorkspace({ index, reading, decision }: SplitWorkspaceProps) {
  return <div className="split-workspace"><div className="split-workspace__index">{index}</div><div className="split-workspace__reading">{reading}</div><div className="split-workspace__decision">{decision}</div></div>;
}
