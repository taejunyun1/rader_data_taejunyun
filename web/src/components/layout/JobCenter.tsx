import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import {
  isActiveResearchJob,
  jobFailurePresentation,
  jobResultTarget,
  jobTitle,
  visualExtractionCountSummary,
} from "../../lib/researchJobs";

interface Props {
  jobs: ResearchJob[];
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

export default function JobCenter({ jobs, onDismiss, onRetry, onResult }: Props) {
  if (jobs.length === 0) return null;
  return (
    <div className="job-center" aria-label="백그라운드 작업">
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
