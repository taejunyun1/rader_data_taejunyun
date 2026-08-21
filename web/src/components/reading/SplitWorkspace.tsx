import type { ReactNode } from "react";

interface SplitWorkspaceProps {
  index: ReactNode;
  reading: ReactNode;
}

export default function SplitWorkspace({ index, reading }: SplitWorkspaceProps) {
  return <div className="split-workspace"><div className="split-workspace__index">{index}</div><div className="split-workspace__reading">{reading}</div></div>;
}
