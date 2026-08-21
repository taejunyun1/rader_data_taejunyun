import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiscoverySourcePreset, View } from "@radar/shared";
import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import { deriveSourceAccess } from "../lib/sourceAccess";
import { labelOf, PROVIDER_LABELS } from "../lib/labels";
import { runTask, useTasks } from "../lib/tasks";
import PageHeader from "../components/layout/PageHeader";
import DecisionRail from "../components/reading/DecisionRail";
import ReadingPane from "../components/reading/ReadingPane";
import SourceIndex from "../components/reading/SourceIndex";
import SplitWorkspace from "../components/reading/SplitWorkspace";
import StatusMessage from "../components/ui/StatusMessage";
import type { DecisionAction, ReadingDocument, SourceIndexItem } from "../components/reading/types";

interface Candidate {
  id: string;
  openalexId: string | null;
  title: string;
  titleKo?: string | null;
  originalTitle?: string | null;
  authors: string | null;
  year: number | null;
  relevanceScore: number | null;
  status: string;
  queryUsed: string | null;
  provider?: string;
  externalUrl?: string | null;
}

interface HomepageProject { slug: string; title: string; year: number | null; projectUrl: string; imageCount: number; videoCount: number; }

const STATUS_FILTERS = [
  { value: "CANDIDATE", label: "새 후보" },
  { value: "KEPT", label: "보관됨" },
  { value: "WATCHED", label: "관찰 중" },
  { value: "IGNORED", label: "제외됨" },
];

const DISCOVERY_ACTIONS: DecisionAction[] = [
  { id: "develop", label: "발전시키기", description: "저장소에 보관하고 연구 방향에 반영" },
  { id: "keep", label: "보관하기", description: "저장소에 남겨 다시 읽기" },
  { id: "watch", label: "관찰하기", description: "관련 흐름이 생길 때 다시 보기" },
  { id: "ignore", label: "제외하기", description: "추천 우선순위만 낮추기" },
];

function candidateAccess(candidate: Candidate) {
  return deriveSourceAccess({ provider: candidate.provider, href: candidate.externalUrl ?? candidate.openalexId });
}

function toIndexItem(candidate: Candidate): SourceIndexItem {
  return {
    id: candidate.id,
    title: candidate.titleKo?.trim() || candidate.title,
    meta: ["후보", labelOf(PROVIDER_LABELS, candidate.provider), candidate.year, candidate.relevanceScore == null ? null : `관련도 ${candidate.relevanceScore.toFixed(2)}`].filter(Boolean).join(" · "),
    tags: candidate.queryUsed ? [candidate.queryUsed] : [],
    access: candidateAccess(candidate),
  };
}

function toReadingDocument(candidate: Candidate): ReadingDocument {
  return {
    id: candidate.id,
    title: candidate.titleKo?.trim() || candidate.title,
    originalTitle: candidate.originalTitle?.trim() || (candidate.titleKo?.trim() ? candidate.title : undefined),
    byline: [candidate.authors, candidate.year, labelOf(PROVIDER_LABELS, candidate.provider)].filter(Boolean).map(String).join(" · "),
    provenance: `발견 후보 · ${candidate.queryUsed ? `검색어 ${candidate.queryUsed}` : "검색어 정보 없음"}`,
    access: candidateAccess(candidate),
    summary: null,
    fragments: [],
    questions: [candidate.queryUsed ? `${candidate.queryUsed}와 이 자료는 어떤 관계를 갖는가?` : "이 자료가 지금의 작업과 어떤 관계를 갖는가?"],
    keywords: [],
  };
}

export default function DiscoverView({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [statusFilter, setStatusFilter] = useState("CANDIDATE");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [queries, setQueries] = useState("");
  const [savedQueries, setSavedQueries] = useState<string[]>([]);
  const [feeds, setFeeds] = useState("");
  const [feedMsg, setFeedMsg] = useState("");
  const [homepageProjects, setHomepageProjects] = useState<HomepageProject[]>([]);
  const [homepageExtractedAt, setHomepageExtractedAt] = useState<string | null>(null);
  const tasks = useTasks();
  const discoverBusy = tasks.some((task) => task.label === "발견 수집" && task.status === "running");

  const load = useCallback(async () => {
    setListError("");
    try {
      const response = await fetch(`/api/discover/candidates?status=${statusFilter}`);
      if (!response.ok) throw new Error("candidates_failed");
      const data = await response.json() as { items?: Candidate[] };
      const next = data.items ?? [];
      setCandidates(next);
      setSelectedId((current) => current && next.some((candidate) => candidate.id === current) ? current : next[0]?.id ?? null);
    } catch { setListError("발견 후보를 불러오지 못했습니다."); }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    fetch("/api/discover/queries").then((r) => r.json() as Promise<{ queries: string[] }>).then((data) => { setSavedQueries(data.queries ?? []); setQueries((data.queries ?? []).join("\n")); }).catch(() => undefined);
    fetch("/api/discover/feeds").then((r) => r.json() as Promise<{ feeds: string[] }>).then((data) => setFeeds((data.feeds ?? []).join("\n"))).catch(() => undefined);
    fetch("/api/settings/homepage").then((r) => r.json() as Promise<{ extractedAt?: string; projects?: HomepageProject[] }>).then((data) => { setHomepageProjects(data.projects ?? []); setHomepageExtractedAt(data.extractedAt ?? null); }).catch(() => undefined);
  }, []);

  async function runDiscovery() {
    await runTask("발견 수집", async (setTaskMsg, setProgress) => {
      setTaskMsg("후보를 모으는 중");
      setProgress(25);
      const response = await fetch("/api/discover/run", { method: "POST" });
      const data = await response.json() as { collected?: number; queries?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "발견 실행에 실패했습니다.");
      setProgress(80);
      setTaskMsg(`${data.collected ?? 0}개 수집 완료`);
      setMsg(`새 후보 ${data.collected ?? 0}개를 모았습니다.${data.queries?.length ? ` 검색어: ${data.queries.join(", ")}` : ""}`);
      setStatusFilter("CANDIDATE");
      await load();
    });
  }

  async function act(id: string, action: DecisionAction["id"]) {
    setBusy(true);
    try {
      const backendAction = action === "develop" || action === "keep" ? "keep" : action;
      const response = await fetch(`/api/discover/candidates/${id}/${backendAction}`, { method: "POST" });
      const data = await response.json() as { status?: string; sourceId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "분류 저장에 실패했습니다.");
      if (action === "develop" && data.sourceId) {
        await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: data.sourceId, action: "develop" }) });
        setMsg("발전시키기로 기록했습니다. 저장소에서 이어 읽습니다.");
        onNavigate("RESERVOIR");
      } else {
        setMsg(`${action === "keep" ? "보관하기" : action === "watch" ? "관찰하기" : "제외하기"}로 기록했습니다.`);
      }
      await load();
    } catch (error) { setMsg(error instanceof Error ? error.message : "분류를 저장하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function saveQueries() {
    const list = queries.split("\n").map((query) => query.trim()).filter(Boolean).slice(0, 4);
    const response = await fetch("/api/discover/queries", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: list }) });
    if (response.ok) { setSavedQueries(list); setMsg("검색어를 저장했습니다."); }
  }

  async function saveFeeds() {
    const list = feeds.split("\n").map((feed) => feed.trim()).filter((feed) => /^https?:\/\//.test(feed)).slice(0, 6);
    const response = await fetch("/api/discover/feeds", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feeds: list }) });
    setFeedMsg(response.ok ? `${list.length}개 피드를 저장했습니다.` : "피드 저장에 실패했습니다.");
  }

  const selected = useMemo(() => candidates.find((candidate) => candidate.id === selectedId) ?? null, [candidates, selectedId]);
  const document = selected ? toReadingDocument(selected) : null;

  return (
    <div className="view-stack">
      <PageHeader title="발견" description="새로운 후보를 읽고, 다음 연구 행동을 바로 결정합니다." primaryAction={<button className="ui-button" disabled={discoverBusy} onClick={() => void runDiscovery()}>{discoverBusy ? "수집 중…" : "지금 새로 찾기"}</button>} />
      <div className="discovery-toolbar">
        <div className="filter-strip" aria-label="후보 상태 필터">
          {STATUS_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${statusFilter === filter.value ? " is-active" : ""}`} onClick={() => setStatusFilter(filter.value)}>{filter.label}</button>)}
        </div>
        <span className="table-note">{savedQueries.length ? `저장된 검색어 ${savedQueries.length}개` : "기본 검색어로 수집 중"} · 최대 20개/회</span>
      </div>
      {msg && <p className="reservoir-message" role="status">{msg}</p>}
      {listError ? <StatusMessage kind="error" title={listError} action={<button className="ui-button-secondary" onClick={() => void load()}>다시 시도</button>} /> : <SplitWorkspace
        index={<SourceIndex title="발견 후보" items={candidates.map(toIndexItem)} selectedId={selectedId} onSelect={setSelectedId} />}
        reading={document ? <ReadingPane document={document} /> : <StatusMessage kind="empty" title="읽을 후보를 선택하세요" description="왼쪽 목록에서 후보를 고르면 실제 접근 링크와 함께 읽기 질문을 확인할 수 있습니다." />}
        decision={document ? <DecisionRail actions={DISCOVERY_ACTIONS} pending={busy} onAction={(action) => void act(document.id, action)} /> : null}
      />}
      <details className="discovery-settings">
        <summary>발견 범위와 수집 출처 조정</summary>
        <div className="discovery-settings__grid">
          <section><h2>검색어</h2><p>한 줄에 하나씩, 최대 4개를 추가합니다. 기본 모멘텀 검색어에 더해집니다.</p><textarea value={queries} onChange={(event) => setQueries(event.target.value)} placeholder="예: 계산 사진\n예: 이미지 형성" /><button className="ui-button-secondary" onClick={() => void saveQueries()}>검색어 저장</button></section>
          <section><h2>RSS·Atom 피드</h2><p>공개 피드만 자동 수집합니다. 한 줄에 하나씩, 최대 6개입니다.</p><textarea value={feeds} onChange={(event) => setFeeds(event.target.value)} placeholder="https://some-journal.org/rss" /><button className="ui-button-secondary" onClick={() => void saveFeeds()}>피드 저장</button>{feedMsg && <span className="table-note">{feedMsg}</span>}</section>
        </div>
        <section className="discovery-sources"><h2>추천 출처 · 직접 읽기</h2><p>자동 수집 여부와 관계없이, 아래 링크에서 실제 자료를 확인할 수 있습니다.</p>{DISCOVERY_SOURCE_PRESETS.map((source: DiscoverySourcePreset) => <div className="discovery-source__row" key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a><span>{source.description} · {source.feedUrl ? "자동 수집" : source.id === "riss" ? "기관·검색 확인" : "직접 읽기"}</span></div>)}</section>
        {homepageProjects.length > 0 && <section className="discovery-sources"><h2>내 홈페이지 기반 출발점</h2><p>홈페이지에서 추출된 프로젝트가 발견 검색의 맥락으로 사용됩니다{homepageExtractedAt ? ` · 마지막 추출 ${new Date(homepageExtractedAt).toLocaleDateString("ko-KR")}` : ""}.</p>{homepageProjects.slice(0, 5).map((project) => <div className="discovery-source__row" key={project.slug}><a href={project.projectUrl} target="_blank" rel="noreferrer">{project.title} ↗</a><span>{project.year ?? "연도 미상"} · 이미지 {project.imageCount} · 영상 {project.videoCount}</span></div>)}</section>}
      </details>
    </div>
  );
}
