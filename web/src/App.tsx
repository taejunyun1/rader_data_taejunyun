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
import { dismissPdfVisualExtractionTask, resumePdfVisualExtractionTask, stopPdfVisualExtractionTask, usePdfVisualExtractionTasks, type PdfPreparationTask } from "./lib/pdfVisualExtractionManager";
import type { ResearchJobResultRef } from "@radar/shared/discovery";

export default function App() {
  const [view, setView] = useState<View>("RADAR");
  const [usage, setUsage] = useState<UsageBadge | null>(null);
  const { jobs, refresh, dismiss, retry } = useResearchJobs();
  const pdfTasks = usePdfVisualExtractionTasks();
  const [focus, setFocus] = useState<{ distillSessionId?: string; radarPeriod?: RadarPeriod; reservoirSourceId?: string; reservoirExtractionRunId?: string }>({});

  function openJobResult(result: ResearchJobResultRef) {
    setView(result.view === "VISUAL" ? "RESERVOIR" : result.view);
    if (result.view === "DISTILL") setFocus({ distillSessionId: result.sessionId });
    if (result.view === "RADAR") setFocus({ radarPeriod: result.period });
    if (result.view === "RESERVOIR") setFocus({
      reservoirSourceId: result.sourceId,
      reservoirExtractionRunId: "acquisition" in result && result.acquisition ? result.extractionRunId : undefined,
    });
  }

  const openReservoirSource = useCallback((sourceId: string) => {
    setFocus({ reservoirSourceId: sourceId, reservoirExtractionRunId: undefined });
    setView("RESERVOIR");
  }, []);

  const consumeReservoirFocus = useCallback(() => {
    setFocus((current) => ({ ...current, reservoirSourceId: undefined, reservoirExtractionRunId: undefined }));
  }, []);

  const consumeFocus = useCallback((key: "distillSessionId" | "radarPeriod" | "reservoirSourceId") => {
    setFocus((current) => ({ ...current, [key]: undefined }));
  }, []);
  const consumeDistillFocus = useCallback(() => consumeFocus("distillSessionId"), [consumeFocus]);
  const consumeRadarFocus = useCallback(() => consumeFocus("radarPeriod"), [consumeFocus]);

  const stopPdfTask = useCallback((task: PdfPreparationTask) => {
    stopPdfVisualExtractionTask(task.sourceId, task.sourceVersionId);
  }, []);

  const resumePdfTask = useCallback((task: PdfPreparationTask) => {
    const handle = resumePdfVisualExtractionTask(task.sourceId, task.sourceVersionId);
    if (handle) void handle.promise.then((result) => {
      if (result?.status === "QUEUED" || result?.status === "RUNNING") void refresh();
    });
  }, [refresh]);

  useEffect(() => {
    pdfTasks.filter((task) => task.status === "QUEUED").forEach((task) => {
      const finished = jobs.find((job) => {
        if (job.kind !== "VISUAL_EXTRACTION" || !["SUCCEEDED", "FAILED", "BLOCKED"].includes(job.status)) return false;
        const input = job.input && typeof job.input === "object" ? job.input as { sourceId?: unknown; sourceVersionId?: unknown } : null;
        return input?.sourceId === task.sourceId && input?.sourceVersionId === task.sourceVersionId;
      });
      if (finished) dismissPdfVisualExtractionTask(task.sourceId, task.sourceVersionId);
    });
  }, [jobs, pdfTasks]);

  useEffect(() => {
    fetch("/api/usage/summary")
      .then((r) => r.json() as Promise<UsageBadge>)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  return (
    <AppShell view={view} onNavigate={setView} usage={usage} jobs={jobs} pdfTasks={pdfTasks} onStopPdfTask={stopPdfTask} onResumePdfTask={resumePdfTask} onDismissJob={dismiss} onRetryJob={retry} onResult={openJobResult}>
      {view === "RADAR" && <RadarView onNavigate={setView} onJobCreated={refresh} focusPeriod={focus.radarPeriod} onFocusConsumed={consumeRadarFocus} />}
      {view === "INBOX" && <InboxView />}
      {view === "DISTILL" && <DistillView onJobCreated={refresh} focusSessionId={focus.distillSessionId} onFocusConsumed={consumeDistillFocus} />}
      {view === "RESERVOIR" && <ReservoirView jobs={jobs} onJobCreated={refresh} focusSourceId={focus.reservoirSourceId} focusExtractionRunId={focus.reservoirExtractionRunId} onFocusConsumed={consumeReservoirFocus} />}
      {view === "DISCOVER" && <DiscoverView onNavigate={setView} onOpenReservoir={openReservoirSource} jobs={jobs} onJobCreated={refresh} />}
      {view === "USAGE" && <UsageView />}
      {view === "SETTINGS" && <SettingsView />}
    </AppShell>
  );
}
