import type { ReactNode } from "react";
import type { View } from "@radar/shared";
import type { Task } from "../../lib/tasks";
import SidebarNav from "./SidebarNav";
import TaskCenter from "./TaskCenter";

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
  tasks: Task[];
  children: ReactNode;
}

export default function AppShell({ view, onNavigate, usage, tasks, children }: AppShellProps) {
  return <div className="app-shell"><SidebarNav view={view} onNavigate={onNavigate} usage={usage} /><div className="app-shell__content"><TaskCenter tasks={tasks} /><main className="app-shell__main">{children}</main></div></div>;
}
