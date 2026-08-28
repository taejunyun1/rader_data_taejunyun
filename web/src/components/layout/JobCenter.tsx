import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import {
  isActiveResearchJob,
  jobFailurePresentation,
  jobResultTarget,
  jobTitle,
  visualExtractionCountSummary,
} from "../../lib/researchJobs";
import type { PdfPreparationTask } from "../../lib/pdfVisualExtractionManager";

interface Props {
  jobs: ResearchJob[];
  pdfTasks?: PdfPreparationTask[];
  onStopPdfTask?: (task: PdfPreparationTask) => void;
  onResumePdfTask?: (task: PdfPreparationTask) => void;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
  onResult: (result: ResearchJobResultRef) => void;
}

function statusLabel(job: ResearchJob): string {
  if (job.status === "QUEUED") return "대기 중";
  if (job.status === "RUNNING") return `${job.progress}%`;
  if (job.status === "SUCCEEDED") return "완료";
  if (job.status === "BLOCKED") return "설정 확인 필요";
  return "실패";
}

function pdfTaskStatusLabel(task: PdfPreparationTask): string {
  if (task.status === "PREPARING") return "원본 확인 중";
  if (task.status === "UPLOADING") return "페이지 준비 중";
  if (task.status === "FINALIZING") return "분석 준비 중";
  if (task.status === "QUEUED") return "시각 후보 분석 대기 중";
  if (task.status === "FAILED") return "준비 실패";
  return "일시 중지됨";
}

function PdfPreparationItem({ task, onStop, onResume }: { task: PdfPreparationTask; onStop?: (task: PdfPreparationTask) => void; onResume?: (task: PdfPreparationTask) => void }) {
  const canStop = ["PREPARING", "UPLOADING", "FINALIZING"].includes(task.status);
  const pageLabel = `${task.uploadedPages.toLocaleString("ko-KR")}/${task.totalPages.toLocaleString("ko-KR")}쪽`;
  return (
    <div className={`job-center__item job-center__item--pdf-${task.status.toLowerCase()}`}>
      <span className="job-center__status" aria-hidden="true">●</span>
      <div className="job-center__body">
        <strong>{task.title} · PDF 페이지 준비 · {pageLabel}</strong>
        <span>{pdfTaskStatusLabel(task)}{task.currentPage ? ` · ${task.currentPage}쪽 처리 완료` : ""}</span>
        {task.errorCode && <span>{task.errorCode}</span>}
      </div>
      {canStop && onStop && <button className="job-center__action" aria-label="PDF 페이지 준비 중지" type="button" onClick={() => onStop(task)}>중지</button>}
      {(task.status === "PAUSED" || task.status === "FAILED") && onResume && <button className="job-center__action" aria-label="PDF 페이지 준비 계속" type="button" onClick={() => onResume(task)}>계속</button>}
    </div>
  );
}

export default function JobCenter({ jobs, pdfTasks = [], onStopPdfTask, onResumePdfTask, onDismiss, onRetry, onResult }: Props) {
  if (jobs.length === 0 && pdfTasks.length === 0) return null;
  return (
    <div className="job-center" aria-label="백그라운드 작업">
      {pdfTasks.slice(0, 3).map((task) => <PdfPreparationItem key={`${task.sourceId}:${task.sourceVersionId}`} task={task} onStop={onStopPdfTask} onResume={onResumePdfTask} />)}
      {jobs.slice(0, 5).map((job) => {
        const countSummary = visualExtractionCountSummary(job);
        const failure = jobFailurePresentation(job);
        return (
        <div className={`job-center__item job-center__item--${job.status.toLowerCase()}`} key={job.id}>
          <span className="job-center__status" aria-hidden="true">{isActiveResearchJob(job) ? "●" : job.status === "SUCCEEDED" ? "✓" : "!"}</span>
          <div className="job-center__body">
            <strong>{jobTitle(job)} · {statusLabel(job)}</strong>
            {job.message && <span>{job.message}</span>}
            {countSummary.primary && <span>{countSummary.primary}</span>}
            {countSummary.secondary && <span>{countSummary.secondary}</span>}
            {failure?.message && <span>{failure.message}</span>}
          </div>
          {job.status === "SUCCEEDED" && job.resultRef && <button className="job-center__action" type="button" onClick={() => {
            const target = jobResultTarget(job);
            if (target) onResult(target);
          }}>결과 보기</button>}
          {failure?.sourceUrl && (
            <a
              className="job-center__action"
              href={failure.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              원문 열기
            </a>
          )}
          {(job.status === "FAILED" || job.status === "BLOCKED")
            && (failure?.retryable ?? true)
            && (
              <button className="job-center__action" type="button" onClick={() => onRetry(job.id)}>다시 실행</button>
            )}
          {!isActiveResearchJob(job) && <button className="job-center__dismiss" aria-label={`${jobTitle(job)} 닫기`} type="button" onClick={() => onDismiss(job.id)}>×</button>}
        </div>
      );})}
    </div>
  );
}
