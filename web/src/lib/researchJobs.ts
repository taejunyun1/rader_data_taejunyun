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
