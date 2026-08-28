import type { ReactNode } from "react";
import type { View } from "@radar/shared";
import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import type { PdfPreparationTask } from "../../lib/pdfVisualExtractionManager";
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
  pdfTasks?: PdfPreparationTask[];
  onStopPdfTask?: (task: PdfPreparationTask) => void;
  onResumePdfTask?: (task: PdfPreparationTask) => void;
  onDismissJob: (id: string) => void;
  onRetryJob: (id: string) => void;
  onResult: (result: ResearchJobResultRef) => void;
  children: ReactNode;
}

export default function AppShell({ view, onNavigate, usage, jobs, pdfTasks = [], onStopPdfTask, onResumePdfTask, onDismissJob, onRetryJob, onResult, children }: AppShellProps) {
  return <div className="app-shell"><SidebarNav view={view} onNavigate={onNavigate} usage={usage} jobs={jobs} pdfTasks={pdfTasks} /><div className="app-shell__content"><JobCenter jobs={jobs} pdfTasks={pdfTasks} onStopPdfTask={onStopPdfTask} onResumePdfTask={onResumePdfTask} onDismiss={onDismissJob} onRetry={onRetryJob} onResult={onResult} /><main className="app-shell__main">{children}</main></div></div>;
}
