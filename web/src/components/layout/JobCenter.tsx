import type { ResearchJob, ResearchJobResultRef } from "@radar/shared/discovery";
import { isActiveResearchJob, jobLabel } from "../../lib/researchJobs";

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
      {jobs.slice(0, 5).map((job) => (
        <div className={`job-center__item job-center__item--${job.status.toLowerCase()}`} key={job.id}>
          <span className="job-center__status" aria-hidden="true">{isActiveResearchJob(job) ? "●" : job.status === "SUCCEEDED" ? "✓" : "!"}</span>
          <div className="job-center__body"><strong>{jobLabel(job.kind)} · {statusLabel(job)}</strong>{job.message && <span>{job.message}</span>}{job.error && <span>{job.error}</span>}</div>
          {job.status === "SUCCEEDED" && job.resultRef && <button className="job-center__action" type="button" onClick={() => onResult(job.resultRef!)}>결과 보기</button>}
          {(job.status === "FAILED" || job.status === "BLOCKED") && <button className="job-center__action" type="button" onClick={() => onRetry(job.id)}>다시 실행</button>}
          {!isActiveResearchJob(job) && <button className="job-center__dismiss" aria-label={`${jobLabel(job.kind)} 닫기`} type="button" onClick={() => onDismiss(job.id)}>×</button>}
        </div>
      ))}
    </div>
  );
}
