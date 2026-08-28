import type { View } from "@radar/shared";
import type { ResearchJob } from "@radar/shared/discovery";
import { PRIMARY_VIEWS, UTILITY_VIEWS, VIEW_META } from "../../lib/ui";
import { isActiveResearchJob, jobLabel } from "../../lib/researchJobs";
import type { UsageBadge } from "./AppShell";
import type { PdfPreparationTask } from "../../lib/pdfVisualExtractionManager";

interface SidebarNavProps {
  view: View;
  onNavigate: (view: View) => void;
  usage: UsageBadge | null;
  counts?: Partial<Record<View, number>>;
  jobs?: ResearchJob[];
  pdfTasks?: PdfPreparationTask[];
}

function NavButton({ view, active, count, onNavigate }: { view: View; active: boolean; count?: number; onNavigate: (view: View) => void }) {
  return (
    <button className={`sidebar-nav__item${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={() => onNavigate(view)}>
      <span>{VIEW_META[view].label}</span>
      {typeof count === "number" && <span className="sidebar-nav__count">{count}</span>}
    </button>
  );
}

const JOB_VIEWS: Record<ResearchJob["kind"], View> = {
  DISCOVERY_RUN: "DISCOVER",
  DISTILL_RUN: "DISTILL",
  RADAR_SYNTHESIS: "RADAR",
  DEEP_ANALYSIS: "RESERVOIR",
  SOURCE_ACQUISITION: "RESERVOIR",
  VISUAL_TRANSFORM: "RESERVOIR",
  VISUAL_ANALYSIS: "RESERVOIR",
  VISUAL_EXTRACTION: "RESERVOIR",
};

export default function SidebarNav({ view, onNavigate, usage, counts = {}, jobs = [], pdfTasks = [] }: SidebarNavProps) {
  const activeJobs = jobs.filter(isActiveResearchJob).slice(0, 3);
  const visiblePdfTasks = pdfTasks.slice(0, 2);
  return (
    <aside className="sidebar-nav" aria-label="주 탐색">
      <div className="sidebar-nav__brand" aria-label="리서치 레이더">리서치 <span>레이더</span></div>
      <nav className="sidebar-nav__primary">
        {PRIMARY_VIEWS.map((item) => <NavButton key={item} view={item} active={item === view} count={counts[item]} onNavigate={onNavigate} />)}
      </nav>
      {(activeJobs.length > 0 || visiblePdfTasks.length > 0) && <div className="sidebar-nav__jobs" aria-label="진행 중인 작업">
        {activeJobs.map((job) => <button key={job.id} className="sidebar-nav__job" type="button" aria-label={`${jobLabel(job.kind)} ${job.status === "QUEUED" ? "대기" : `${job.progress}%`}`} onClick={() => onNavigate(JOB_VIEWS[job.kind])}>
          <span><i aria-hidden="true">●</i>{jobLabel(job.kind)}</span><strong>{job.status === "QUEUED" ? "대기" : `${job.progress}%`}</strong>
        </button>)}
        {visiblePdfTasks.map((task) => <button key={`${task.sourceId}:${task.sourceVersionId}`} className="sidebar-nav__job" type="button" aria-label={`PDF 페이지 준비 ${task.title} ${task.uploadedPages}/${task.totalPages}쪽`} onClick={() => onNavigate("RESERVOIR")}>
          <span><i aria-hidden="true">●</i>PDF 준비</span><strong>{task.totalPages > 0 ? `${task.uploadedPages}/${task.totalPages}` : "준비"}</strong>
        </button>)}
      </div>}
      <div className="sidebar-nav__utility">
        <button className="sidebar-nav__usage" onClick={() => onNavigate("USAGE")}><span>AI 사용량</span><span>{usage ? `${Math.round(usage.usedPct)}%` : "확인 중"}</span></button>
        {UTILITY_VIEWS.filter((item) => item !== "USAGE").map((item) => <NavButton key={item} view={item} active={item === view} count={counts[item]} onNavigate={onNavigate} />)}
      </div>
    </aside>
  );
}
