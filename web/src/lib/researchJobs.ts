import { useCallback, useEffect, useRef, useState } from "react";
import type { ResearchJob, ResearchJobKind, ResearchJobResultRef, ResearchJobStatus } from "@radar/shared/discovery";

export function isActiveResearchJob(job: Pick<ResearchJob, "status">): boolean {
  return job.status === "QUEUED" || job.status === "RUNNING";
}

export function jobLabel(kind: ResearchJobKind): string {
  return ({
    DISCOVERY_RUN: "발견 수집",
    DISTILL_RUN: "착즙",
    RADAR_SYNTHESIS: "레이더 생성",
    DEEP_ANALYSIS: "심층 정리",
    SOURCE_ACQUISITION: "원문 수집",
    VISUAL_TRANSFORM: "이미지 변환",
    VISUAL_ANALYSIS: "이미지 분석",
    VISUAL_EXTRACTION: "시각 자료 추출",
  })[kind];
}

function visualExtractionSourceKind(job: ResearchJob): "HTML" | "PDF" | null {
  const result = job.result;
  if (!result || typeof result !== "object") return null;
  const diagnostics = (result as { diagnostics?: unknown }).diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const sourceKind = (diagnostics as { sourceKind?: unknown }).sourceKind;
  return sourceKind === "HTML" || sourceKind === "PDF" ? sourceKind : null;
}

function visualExtractionReviewCount(job: ResearchJob): number {
  const result = job.result;
  if (!result || typeof result !== "object") return 0;
  const counts = (result as { counts?: unknown }).counts;
  if (!counts || typeof counts !== "object") return 0;
  return Number((counts as { review?: unknown }).review ?? 0);
}

export function jobTitle(job: ResearchJob): string {
  if (job.kind !== "VISUAL_EXTRACTION") return jobLabel(job.kind);
  if (visualExtractionReviewCount(job) > 0) return "일부 이미지 확인 필요";
  if (visualExtractionSourceKind(job) === "PDF") return "PDF 이미지 추출";
  if (visualExtractionSourceKind(job) === "HTML") return "웹 이미지 추출";
  return jobLabel(job.kind);
}

export function visualExtractionCountSummary(job: ResearchJob): { primary: string | null; secondary: string | null } {
  if (job.kind !== "VISUAL_EXTRACTION" || !job.result || typeof job.result !== "object") {
    return { primary: null, secondary: null };
  }
  const result = job.result as {
    counts?: { selected?: unknown; review?: unknown; filtered?: unknown; unavailable?: unknown };
    outcomeCounts?: { duplicateExact?: unknown; duplicateNear?: unknown; rightsGated?: unknown; cleanupFailures?: unknown };
  };
  const counts = result.counts;
  if (!counts || typeof counts !== "object") return { primary: null, secondary: null };
  const primary = `선정 ${Number(counts.selected ?? 0)} · 검토 ${Number(counts.review ?? 0)} · 제외 ${Number(counts.filtered ?? 0)} · 사용 불가 ${Number(counts.unavailable ?? 0)}`;
  const outcomeCounts = result.outcomeCounts;
  if (!outcomeCounts || typeof outcomeCounts !== "object") return { primary, secondary: null };
  const outcomeEntries: Array<[string, number]> = [
    ["정확 중복", Number(outcomeCounts.duplicateExact ?? 0)],
    ["유사 중복", Number(outcomeCounts.duplicateNear ?? 0)],
    ["링크만 보존", Number(outcomeCounts.rightsGated ?? 0)],
    ["임시 정리 실패", Number(outcomeCounts.cleanupFailures ?? 0)],
  ];
  const secondaryEntries = outcomeEntries.filter((entry): entry is [string, number] => entry[1] > 0);
  return {
    primary,
    secondary: secondaryEntries.length > 0
      ? secondaryEntries.map(([label, value]) => `${label} ${value}`).join(" · ")
      : null,
  };
}

export function jobResultTarget(job: ResearchJob): ResearchJobResultRef | null {
  if (job.resultRef?.view === "VISUAL" && "sourceId" in job.resultRef && typeof job.resultRef.sourceId === "string") {
    return {
      view: "RESERVOIR",
      sourceId: job.resultRef.sourceId,
      acquisition: true,
      ...(job.resultRef.extractionRunId ? { extractionRunId: job.resultRef.extractionRunId } : {}),
    };
  }
  return job.resultRef;
}

export function normalizeResearchJob(value: unknown): ResearchJob | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.kind !== "string" || typeof raw.status !== "string") return null;
  return {
    id: raw.id,
    workflowInstanceId: typeof raw.workflowInstanceId === "string" ? raw.workflowInstanceId : null,
    kind: raw.kind as ResearchJobKind,
    status: raw.status as ResearchJobStatus,
    progress: Number(raw.progress ?? 0),
    message: typeof raw.message === "string" ? raw.message : null,
    input: raw.input ?? null,
    result: raw.result ?? null,
    resultRef: raw.resultRef as ResearchJobResultRef | null,
    errorCode: typeof raw.errorCode === "string" ? raw.errorCode : null,
    error: typeof raw.error === "string" ? raw.error : null,
    retryOf: typeof raw.retryOf === "string" ? raw.retryOf : null,
    requestedBy: typeof raw.requestedBy === "string" ? raw.requestedBy : null,
    dedupeKey: typeof raw.dedupeKey === "string" ? raw.dedupeKey : "",
    dismissedAt: typeof raw.dismissedAt === "string" ? raw.dismissedAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

export function useResearchJobs(): {
  jobs: ResearchJob[];
  refresh: () => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
} {
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const timer = useRef<number | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/jobs?status=recent");
      if (!response.ok) return;
      const data = await response.json() as { jobs?: unknown[] };
      setJobs((data.jobs ?? []).map(normalizeResearchJob).filter((job): job is ResearchJob => Boolean(job)));
    } catch {
      /* keep the last known state while Access/network recovers */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const hasActive = jobs.some(isActiveResearchJob);
    if (!hasActive) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void refresh(); }, 2000);
    return () => { if (timer.current !== null) window.clearTimeout(timer.current); };
  }, [jobs, refresh]);

  const dismiss = useCallback(async (id: string) => {
    await fetch(`/api/jobs/${id}/dismiss`, { method: "PATCH" });
    setJobs((current) => current.filter((job) => job.id !== id));
  }, []);

  const retry = useCallback(async (id: string) => {
    const response = await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
    if (response.ok) await refresh();
  }, [refresh]);

  return { jobs, refresh, dismiss, retry };
}
