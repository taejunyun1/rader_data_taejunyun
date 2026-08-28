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

export interface ResearchJobFailurePresentation {
  message: string | null;
  retryable: boolean;
  sourceUrl: string | null;
}

interface RemoteAcquisitionDiagnostic {
  code: string | null;
  status: number | null;
  reason: string | null;
}

function parseRemoteAcquisitionDiagnostic(
  error: string | null,
): RemoteAcquisitionDiagnostic {
  if (error?.startsWith("remote_acquisition_failure;")) {
    const code = error.match(/(?:^|;)code=([A-Z0-9_]+)/)?.[1] ?? null;
    const rawStatus = error.match(/(?:^|;)status=(\d{3})/)?.[1];
    const reason = error.match(/(?:^|;)reason=([A-Z0-9_]+)/)?.[1] ?? null;
    return {
      code,
      status: rawStatus ? Number(rawStatus) : null,
      reason,
    };
  }
  return {
    code: error?.match(/RemoteAcquisitionError:\s*([A-Z0-9_]+)/)?.[1] ?? null,
    status: null,
    reason: null,
  };
}

function acquisitionSourceUrl(job: ResearchJob): string | null {
  if (!job.input || typeof job.input !== "object") return null;
  const raw = (job.input as { url?: unknown }).url;
  if (typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function jobFailurePresentation(
  job: ResearchJob,
): ResearchJobFailurePresentation | null {
  if (job.status !== "FAILED" && job.status !== "BLOCKED") return null;
  if (job.kind !== "SOURCE_ACQUISITION") {
    return {
      message: job.error,
      retryable: true,
      sourceUrl: null,
    };
  }

  const diagnostic = parseRemoteAcquisitionDiagnostic(job.error);
  const permanentStatus = diagnostic.status !== null
    && [401, 403, 404, 410].includes(diagnostic.status);
  const challenged = diagnostic.reason === "ACCESS_CHALLENGE";
  const permanentCode = [
    "UNSUPPORTED_CONTENT_TYPE",
    "SIZE_LIMIT",
    "REDIRECT_BLOCKED",
    "PDF_SIGNATURE_INVALID",
    "EXTRACTION_EMPTY",
  ].includes(diagnostic.code ?? "");

  if (diagnostic.status === 408 || diagnostic.code === "FETCH_TIMEOUT") {
    return {
      message: "원문 사이트의 응답 시간이 초과됐습니다. 잠시 후 다시 실행해 주세요.",
      retryable: true,
      sourceUrl: null,
    };
  }
  if (diagnostic.status === 429) {
    return {
      message: "원문 사이트의 요청 한도에 도달했습니다. 잠시 후 다시 실행해 주세요.",
      retryable: true,
      sourceUrl: null,
    };
  }
  if (permanentStatus || challenged) {
    return {
      message: "원문 사이트가 자동 수집을 허용하지 않습니다. 브라우저에서 원문을 확인하거나, 전문이 필요하면 Inbox에 텍스트 또는 파일로 추가해 주세요.",
      retryable: false,
      sourceUrl: acquisitionSourceUrl(job),
    };
  }
  if (diagnostic.code === "HTTP_5XX") {
    return {
      message: "원문 사이트의 일시적인 서버 오류로 수집하지 못했습니다.",
      retryable: true,
      sourceUrl: null,
    };
  }
  if (permanentCode) {
    return {
      message: "이 링크에서는 지원되는 원문을 가져올 수 없습니다. 원문 형식이나 접근 경로를 확인해 주세요.",
      retryable: false,
      sourceUrl: null,
    };
  }

  return {
    message: "원문 수집을 완료하지 못했습니다.",
    retryable: true,
    sourceUrl: null,
  };
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
