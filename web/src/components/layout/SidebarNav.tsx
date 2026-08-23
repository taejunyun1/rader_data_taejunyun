import type { View } from "@radar/shared";
import type { ResearchJob } from "@radar/shared/discovery";
import { PRIMARY_VIEWS, UTILITY_VIEWS, VIEW_META } from "../../lib/ui";
import { isActiveResearchJob, jobLabel } from "../../lib/researchJobs";
import type { UsageBadge } from "./AppShell";

interface SidebarNavProps {
  view: View;
  onNavigate: (view: View) => void;
  usage: UsageBadge | null;
  counts?: Partial<Record<View, number>>;
  jobs?: ResearchJob[];
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
};

export default function SidebarNav({ view, onNavigate, usage, counts = {}, jobs = [] }: SidebarNavProps) {
  const activeJobs = jobs.filter(isActiveResearchJob).slice(0, 3);
  return (
    <aside className="sidebar-nav" aria-label="주 탐색">
      <div className="sidebar-nav__brand" aria-label="리서치 레이더">리서치 <span>레이더</span></div>
      <nav className="sidebar-nav__primary">
        {PRIMARY_VIEWS.map((item) => <NavButton key={item} view={item} active={item === view} count={counts[item]} onNavigate={onNavigate} />)}
      </nav>
      {activeJobs.length > 0 && <div className="sidebar-nav__jobs" aria-label="진행 중인 작업">
        {activeJobs.map((job) => <button key={job.id} className="sidebar-nav__job" type="button" aria-label={`${jobLabel(job.kind)} ${job.status === "QUEUED" ? "대기" : `${job.progress}%`}`} onClick={() => onNavigate(JOB_VIEWS[job.kind])}>
          <span><i aria-hidden="true">●</i>{jobLabel(job.kind)}</span><strong>{job.status === "QUEUED" ? "대기" : `${job.progress}%`}</strong>
        </button>)}
      </div>}
      <div className="sidebar-nav__utility">
        <button className="sidebar-nav__usage" onClick={() => onNavigate("USAGE")}><span>AI 사용량</span><span>{usage ? `${Math.round(usage.usedPct)}%` : "확인 중"}</span></button>
        {UTILITY_VIEWS.filter((item) => item !== "USAGE").map((item) => <NavButton key={item} view={item} active={item === view} count={counts[item]} onNavigate={onNavigate} />)}
      </div>
    </aside>
  );
}
