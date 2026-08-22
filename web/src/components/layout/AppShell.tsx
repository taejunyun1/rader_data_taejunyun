import type { ReactNode } from "react";
import type { View } from "@radar/shared";
import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import SidebarNav from "./SidebarNav";
import JobCenter from "./JobCenter";

export interface UsageBadge {
  usedUsd: number;
  budgetUsd: number;
  usedPct: number;
  blocked: boolean;
}

export interface AppShellProps {
  view: View;
  onNavigate: (view: View) => void;
  usage: UsageBadge | null;
  jobs: ResearchJob[];
  onDismissJob: (id: string) => void;
  onRetryJob: (id: string) => void;
  onResult: (result: ResearchJobResultRef) => void;
  children: ReactNode;
}

export default function AppShell({ view, onNavigate, usage, jobs, onDismissJob, onRetryJob, onResult, children }: AppShellProps) {
  return <div className="app-shell"><SidebarNav view={view} onNavigate={onNavigate} usage={usage} jobs={jobs} /><div className="app-shell__content"><JobCenter jobs={jobs} onDismiss={onDismissJob} onRetry={onRetryJob} onResult={onResult} /><main className="app-shell__main">{children}</main></div></div>;
}
