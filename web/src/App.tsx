import { useCallback, useEffect, useState } from "react";
import type { RadarPeriod, View } from "@radar/shared";
import AppShell, { type UsageBadge } from "./components/layout/AppShell";
import InboxView from "./views/InboxView";
import DiscoverView from "./views/DiscoverView";
import DistillView from "./views/DistillView";
import RadarView from "./views/RadarView";
import ReservoirView from "./views/ReservoirView";
import SettingsView from "./views/SettingsView";
import UsageView from "./views/UsageView";
import { useResearchJobs } from "./lib/researchJobs";
import type { ResearchJobResultRef } from "@radar/shared/discovery";

export default function App() {
  const [view, setView] = useState<View>("RADAR");
  const [usage, setUsage] = useState<UsageBadge | null>(null);
  const { jobs, refresh, dismiss, retry } = useResearchJobs();
  const [focus, setFocus] = useState<{ distillSessionId?: string; radarPeriod?: RadarPeriod; reservoirSourceId?: string }>({});

  function openJobResult(result: ResearchJobResultRef) {
    setView(result.view);
    if (result.view === "DISTILL") setFocus({ distillSessionId: result.sessionId });
    if (result.view === "RADAR") setFocus({ radarPeriod: result.period });
    if (result.view === "RESERVOIR") setFocus({ reservoirSourceId: result.sourceId });
  }

  const openReservoirSource = useCallback((sourceId: string) => {
    setFocus({ reservoirSourceId: sourceId });
    setView("RESERVOIR");
  }, []);

  const consumeFocus = useCallback((key: "distillSessionId" | "radarPeriod" | "reservoirSourceId") => {
    setFocus((current) => ({ ...current, [key]: undefined }));
  }, []);

  useEffect(() => {
    fetch("/api/usage/summary")
      .then((r) => r.json() as Promise<UsageBadge>)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  return (
    <AppShell view={view} onNavigate={setView} usage={usage} jobs={jobs} onDismissJob={dismiss} onRetryJob={retry} onResult={openJobResult}>
      {view === "RADAR" && <RadarView onNavigate={setView} onJobCreated={refresh} focusPeriod={focus.radarPeriod} onFocusConsumed={() => consumeFocus("radarPeriod")} />}
      {view === "INBOX" && <InboxView />}
      {view === "DISTILL" && <DistillView onJobCreated={refresh} focusSessionId={focus.distillSessionId} onFocusConsumed={() => consumeFocus("distillSessionId")} />}
      {view === "RESERVOIR" && <ReservoirView onJobCreated={refresh} focusSourceId={focus.reservoirSourceId} onFocusConsumed={() => consumeFocus("reservoirSourceId")} />}
      {view === "DISCOVER" && <DiscoverView onNavigate={setView} onOpenReservoir={openReservoirSource} jobs={jobs} onJobCreated={refresh} />}
      {view === "USAGE" && <UsageView />}
      {view === "SETTINGS" && <SettingsView />}
    </AppShell>
  );
}
