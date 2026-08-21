import { useEffect, useState } from "react";
import type { View } from "@radar/shared";
import AppShell, { type UsageBadge } from "./components/layout/AppShell";
import InboxView from "./views/InboxView";
import DiscoverView from "./views/DiscoverView";
import DistillView from "./views/DistillView";
import RadarView from "./views/RadarView";
import ReservoirView from "./views/ReservoirView";
import SettingsView from "./views/SettingsView";
import UsageView from "./views/UsageView";
import { useTasks } from "./lib/tasks";

export default function App() {
  const [view, setView] = useState<View>("RADAR");
  const [usage, setUsage] = useState<UsageBadge | null>(null);
  const tasks = useTasks();

  useEffect(() => {
    fetch("/api/usage/summary")
      .then((r) => r.json() as Promise<UsageBadge>)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  return (
    <AppShell view={view} onNavigate={setView} usage={usage} tasks={tasks}>
      {view === "RADAR" && <RadarView onNavigate={setView} />}
      {view === "INBOX" && <InboxView />}
      {view === "DISTILL" && <DistillView />}
      {view === "RESERVOIR" && <ReservoirView />}
      {view === "DISCOVER" && <DiscoverView onNavigate={setView} />}
      {view === "USAGE" && <UsageView />}
      {view === "SETTINGS" && <SettingsView />}
    </AppShell>
  );
}
