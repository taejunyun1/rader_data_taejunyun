import { useEffect, useState } from "react";
import type { RadarPeriod, View } from "@radar/shared";
import { runTask, useTasks } from "../lib/tasks";
import { RADAR_SECTION_LABELS } from "../lib/labels";
import { type RadarStats, visibleSynthesisSections } from "../lib/radarPresentation";
import PageHeader from "../components/layout/PageHeader";
import RadarOverview from "../components/radar/RadarOverview";
import StatusMessage from "../components/ui/StatusMessage";

interface Synthesis { period: RadarPeriod; narrative: string; sections: { heading: string; items: string[] }[]; biasWatch: string[]; costUsd: number; }
interface QueueItem { id: string; title: string; sourceUrl: string | null; verified: number; whyRead: string | null; }
interface DistillSession { id: string; createdAt: string; }

const PERIODS: { value: RadarPeriod; label: string }[] = [{ value: "WEEKLY", label: "이번 주" }, { value: "MONTHLY", label: "이번 달" }, { value: "YEARLY", label: "올해" }];
const OBJECT_LABELS: Record<string, string> = { observation: "관찰", recommendation: "추천", reason: "이유", evidence: "근거", direction: "방향", note: "메모", question: "질문", summary: "요약", text: "내용", overRepeating: "반복되는 영역" };

function toRenderableText(value: unknown): string | null {
  if (typeof value === "string") return value.trim().replace(/\bDistill\b/gi, "착즙").replace(/\bReservoir\b/gi, "저장소").replace(/\bCounter layer\b/gi, "반대 관점 계층") || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map(toRenderableText).filter((item): item is string => Boolean(item));
    return items.length ? items.join(" · ") : null;
  }
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => { const text = toRenderableText(item); return text ? `${OBJECT_LABELS[key] ?? key}: ${text}` : null; })
    .filter((item): item is string => Boolean(item));
  return entries.length ? entries.join(" · ") : null;
}

function normalizeSynthesis(value: unknown, period: RadarPeriod): Synthesis | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sections = Array.isArray(raw.sections) ? raw.sections.map((section) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) return null;
    const item = section as Record<string, unknown>;
    const items = (Array.isArray(item.items) ? item.items : [item.items]).map(toRenderableText).filter((text): text is string => Boolean(text));
    const rawHeading = toRenderableText(item.heading) ?? "연구 흐름";
    return { heading: RADAR_SECTION_LABELS[rawHeading] ?? rawHeading, items };
  }).filter((section): section is { heading: string; items: string[] } => Boolean(section)) : [];
  return {
    period,
    narrative: toRenderableText(raw.narrative) ?? "생성된 서사 내용이 없습니다.",
    sections,
    biasWatch: Array.isArray(raw.biasWatch) ? raw.biasWatch.map(toRenderableText).filter((text): text is string => Boolean(text)) : [],
    costUsd: typeof raw.costUsd === "number" ? raw.costUsd : 0,
  };
}

export default function RadarView({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [period, setPeriod] = useState<RadarPeriod>("WEEKLY");
  const [stats, setStats] = useState<RadarStats | null>(null);
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);
  const [msg, setMsg] = useState("");
  const tasks = useTasks();
  const busy = tasks.some((task) => task.label === "레이더 생성" && task.status === "running");

  useEffect(() => { fetch(`/api/radar/stats?period=${period}`).then((response) => response.json() as Promise<{ stats?: RadarStats }>).then((data) => setStats(data.stats ?? null)).catch(() => setStats(null)); }, [period]);
  useEffect(() => { fetch("/api/reservoir/topics").then((response) => response.json() as Promise<{ topics?: { topic: string; count: number }[] }>).then((data) => setTopics(data.topics ?? [])).catch(() => undefined); fetch("/api/radar/snapshots").then((response) => response.json() as Promise<{ snapshots?: { period: RadarPeriod; synthesis: unknown }[] }>).then((data) => setSynthesis(normalizeSynthesis(data.snapshots?.find((snapshot) => snapshot.period === period && snapshot.synthesis)?.synthesis, period))).catch(() => setSynthesis(null)); fetch("/api/distill/sessions").then((response) => response.json() as Promise<{ sessions?: DistillSession[] }>).then(async (data) => { const latest = data.sessions?.[0]; if (!latest) return; const detail = await fetch(`/api/distill/sessions/${latest.id}`); if (!detail.ok) return; const result = await detail.json() as { readingQueue?: QueueItem[] }; setQueue((result.readingQueue ?? []).filter((item) => item.verified && item.sourceUrl).slice(0, 3)); }).catch(() => undefined); }, [period]);

  async function runSynthesis() { await runTask("레이더 생성", async (setTaskMsg, setProgress) => { setTaskMsg("기간 서사를 정리하는 중"); setProgress(30); const response = await fetch("/api/radar/synthesize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ period }) }); const data = await response.json() as unknown; if (!response.ok) { const error = data && typeof data === "object" && "error" in data ? String((data as { error?: unknown }).error) : "레이더 생성에 실패했습니다."; throw new Error(error); } setProgress(85); setSynthesis(normalizeSynthesis(data, period)); setMsg("새 레이더를 만들었습니다."); }); }

  return <div className="view-stack"><PageHeader title="레이더" description="읽고 판단한 흔적에서 지금의 연구 방향을 확인합니다." primaryAction={<button className="ui-button" disabled={busy} onClick={() => void runSynthesis()}>{busy ? "정리 중…" : "레이더 새로 만들기"}</button>} />
    <div className="radar-periods">{PERIODS.map((item) => <button key={item.value} className={`filter-button${period === item.value ? " is-active" : ""}`} onClick={() => setPeriod(item.value)}>{item.label}</button>)}</div>{msg && <p className="reservoir-message" role="status">{msg}</p>}
    {!stats ? <StatusMessage kind="empty" title="레이더 자료를 불러오는 중입니다" description="신호와 착즙 기록이 쌓이면 이곳에서 흐름을 읽을 수 있습니다." /> : <div className="radar-dashboard">
      <RadarOverview stats={stats} periodLabel={PERIODS.find((item) => item.value === period)?.label ?? "선택 기간"} />
      <section className="radar-narrative">
        <p className="reading-section__label">{PERIODS.find((item) => item.value === period)?.label}의 서사</p>
        {synthesis ? <><p className="radar-narrative__copy">{synthesis.narrative}</p>{visibleSynthesisSections(synthesis.sections).map((section) => <div className="radar-section" key={section.heading}><h2>{section.heading}</h2>{section.items.map((item) => <p key={item}>{item}</p>)}</div>)}</> : <p className="distill-copy">아직 생성된 서사가 없습니다. 레이더를 새로 만들어 보세요.</p>}
      </section>
      <aside className="radar-side">
        <section><p className="reading-section__label">지금 직접 읽기</p>{queue.length ? queue.map((item) => <article className="radar-queue" key={item.id}><a href={item.sourceUrl ?? "#"} target="_blank" rel="noreferrer">{item.title} ↗</a><span>{item.whyRead ?? "검증된 다음 읽기"}</span></article>) : <p className="table-note">검증된 읽기 큐가 없습니다.</p>}<button className="ui-button-secondary" onClick={() => onNavigate("DISTILL")}>착즙에서 큐 편집</button></section>
        <section><p className="reading-section__label">다음 행동</p><button className="next-action" onClick={() => onNavigate("DISCOVER")}>새 후보 확인 <span>발견으로 이동 →</span></button><button className="next-action" onClick={() => onNavigate("RESERVOIR")}>보존 자료 다시 읽기 <span>저장소로 이동 →</span></button></section>
      </aside>
      <section className="radar-section radar-section--wide radar-questions">
        <h2>남은 질문</h2>
        {stats.newQuestions.length ? stats.newQuestions.slice(0, 5).map((question) => <p className="reading-question" key={question}><span>?</span>{question}</p>) : <p className="table-note">아직 기록된 질문이 없습니다.</p>}
      </section>
      <details className="radar-landscape radar-section--wide">
        <summary>장기 연구 지형 <span>전체 누적 토픽 보기</span></summary>
        {topics.length ? <ol className="radar-landscape__list" aria-label="전체 누적 연구 토픽">{topics.slice(0, 14).map((topic) => <li key={topic.topic}><span>{topic.topic}</span><strong>{topic.count}회</strong></li>)}</ol> : <p className="table-note">주제 태그가 아직 없습니다.</p>}
      </details>
      {synthesis?.biasWatch?.length ? <section className="radar-section radar-section--wide radar-bias"><h2>편향 점검</h2>{synthesis.biasWatch.map((item) => <p key={item}>주의 · {item}</p>)}</section> : null}
    </div>}
  </div>;
}
