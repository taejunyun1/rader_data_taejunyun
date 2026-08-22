import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiscoveryKeywordRecommendation, DiscoveryProfile, DiscoverySourcePreset, View } from "@radar/shared";
import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import { deriveSourceAccess } from "../lib/sourceAccess";
import { labelOf, PROVIDER_LABELS } from "../lib/labels";
import DiscoveryDirectionPanel from "../components/discovery/DiscoveryDirectionPanel";
import PageHeader from "../components/layout/PageHeader";
import DecisionBottomSheet from "../components/reading/DecisionBottomSheet";
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
  accessStatus?: "FREE_FULLTEXT" | "PDF" | "INSTITUTION" | "PAYWALLED" | "UNKNOWN" | null;
  discoveryLane?: "ORIGINAL" | "COUNTER";
  querySource?: string;
}

interface HomepageProject { slug: string; title: string; year: number | null; projectUrl: string; imageCount: number; videoCount: number; }

const STATUS_FILTERS = [
  { value: "CANDIDATE", label: "새 후보" },
  { value: "KEPT", label: "보관됨" },
  { value: "WATCHED", label: "관찰 중" },
  { value: "IGNORED", label: "제외됨" },
];

const LANE_FILTERS = [
  { value: "", label: "전체 방향" },
  { value: "ORIGINAL", label: "오리지널" },
  { value: "COUNTER", label: "카운터" },
];

const DISCOVERY_ACTIONS: DecisionAction[] = [
  { id: "develop", label: "발전시키기", description: "저장소에 보관하고 연구 방향에 반영" },
  { id: "keep", label: "보관하기", description: "다음 리서치까지 표시해 두기" },
  { id: "watch", label: "관찰하기", description: "관련 흐름이 생길 때 다시 보기" },
  { id: "ignore", label: "제외하기", description: "추천 우선순위만 낮추기" },
];

function candidateAccess(candidate: Candidate) {
  return deriveSourceAccess({ provider: candidate.provider, href: candidate.externalUrl ?? candidate.openalexId, accessStatus: candidate.accessStatus ?? undefined });
}

function toIndexItem(candidate: Candidate): SourceIndexItem {
  return {
    id: candidate.id,
    title: candidate.titleKo?.trim() || candidate.title,
    meta: [candidate.discoveryLane === "COUNTER" ? "카운터" : "오리지널", "후보", labelOf(PROVIDER_LABELS, candidate.provider), candidate.year, candidate.relevanceScore == null ? null : `관련도 ${candidate.relevanceScore.toFixed(2)}`].filter(Boolean).join(" · "),
    tags: [candidate.queryUsed, candidate.querySource].filter(Boolean).map(String),
    access: candidateAccess(candidate),
  };
}

function toReadingDocument(candidate: Candidate): ReadingDocument {
  return {
    id: candidate.id,
    title: candidate.titleKo?.trim() || candidate.title,
    originalTitle: candidate.originalTitle?.trim() || (candidate.titleKo?.trim() ? candidate.title : undefined),
    byline: [candidate.authors, candidate.year, labelOf(PROVIDER_LABELS, candidate.provider)].filter(Boolean).map(String).join(" · "),
    provenance: `발견 후보 · ${candidate.discoveryLane === "COUNTER" ? "카운터 방향" : "오리지널 방향"} · ${candidate.queryUsed ? `검색어 ${candidate.queryUsed}` : "검색어 정보 없음"}`,
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
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [pendingAction, setPendingAction] = useState<DecisionAction["id"] | null>(null);
  const [msg, setMsg] = useState("");
  const [listError, setListError] = useState("");
  const [busy, setBusy] = useState(false);
  const [laneFilter, setLaneFilter] = useState("");
  const [profile, setProfile] = useState<DiscoveryProfile>({ original: { keywords: [], strength: 70 }, counter: { keywords: [], strength: 30 }, updatedAt: "" });
  const [profileDraft, setProfileDraft] = useState(profile);
  const [recommendations, setRecommendations] = useState<{ original: DiscoveryKeywordRecommendation[]; counter: DiscoveryKeywordRecommendation[] }>({ original: [], counter: [] });
  const [profileDirty, setProfileDirty] = useState(false);
  const [feeds, setFeeds] = useState("");
  const [feedMsg, setFeedMsg] = useState("");
  const [homepageProjects, setHomepageProjects] = useState<HomepageProject[]>([]);
  const [homepageExtractedAt, setHomepageExtractedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListError("");
    try {
      const response = await fetch(`/api/discover/candidates?status=${statusFilter}${laneFilter ? `&lane=${laneFilter}` : ""}`);
      if (!response.ok) throw new Error("candidates_failed");
      const data = await response.json() as { items?: Candidate[] };
      const next = data.items ?? [];
      setCandidates(next);
      setSelectedId((current) => current && next.some((candidate) => candidate.id === current) ? current : next[0]?.id ?? null);
    } catch { setListError("발견 후보를 불러오지 못했습니다."); }
  }, [laneFilter, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    fetch("/api/discover/profile").then((r) => r.json() as Promise<{ profile?: DiscoveryProfile }>).then((data) => { if (data.profile) { setProfile(data.profile); setProfileDraft(data.profile); } }).catch(() => undefined);
    fetch("/api/discover/recommendations").then((r) => r.json() as Promise<{ recommendations?: { original?: DiscoveryKeywordRecommendation[]; counter?: DiscoveryKeywordRecommendation[] } }>).then((data) => setRecommendations({ original: data.recommendations?.original ?? [], counter: data.recommendations?.counter ?? [] })).catch(() => undefined);
    fetch("/api/discover/feeds").then((r) => r.json() as Promise<{ feeds: string[] }>).then((data) => setFeeds((data.feeds ?? []).join("\n"))).catch(() => undefined);
    fetch("/api/settings/homepage").then((r) => r.json() as Promise<{ extractedAt?: string; projects?: HomepageProject[] }>).then((data) => { setHomepageProjects(data.projects ?? []); setHomepageExtractedAt(data.extractedAt ?? null); }).catch(() => undefined);
  }, []);

  async function runDiscovery() {
    setBusy(true);
    try {
      const response = await fetch("/api/discover/run", { method: "POST" });
      const data = await response.json() as { job?: unknown; reused?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? "발견 실행을 시작하지 못했습니다.");
      setMsg(data.reused ? "이미 진행 중인 발견 수집을 계속합니다." : "발견 수집을 시작했습니다. 완료되면 상단 작업센터에서 후보를 확인할 수 있습니다.");
      setStatusFilter("CANDIDATE");
    } catch (error) { setMsg(error instanceof Error ? error.message : "발견 실행을 시작하지 못했습니다."); }
    finally { setBusy(false); }
  }

  async function act(id: string, action: DecisionAction["id"]) {
    setBusy(true);
    setPendingAction(action);
    setDecisionError("");
    try {
      const backendAction = action === "develop" || action === "keep" ? "keep" : action;
      const response = await fetch(`/api/discover/candidates/${id}/${backendAction}`, { method: "POST" });
      const data = await response.json() as { status?: string; sourceId?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "분류 저장에 실패했습니다.");
      if (action === "develop" && data.sourceId) {
        await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: data.sourceId, action: "develop" }) });
        setMsg("발전시키기로 기록했습니다. 저장소에서 이어 읽습니다.");
        setDecisionOpen(false);
        onNavigate("RESERVOIR");
      } else {
        setMsg(`${action === "keep" ? "보관하기" : action === "watch" ? "관찰하기" : "제외하기"}로 기록했습니다.`);
        setDecisionOpen(false);
      }
      await load();
    } catch (error) { setDecisionError(error instanceof Error ? error.message : "분류를 저장하지 못했습니다."); }
    finally { setBusy(false); setPendingAction(null); }
  }

  function selectCandidate(id: string) {
    setSelectedId(id);
    setDecisionError("");
    setDecisionOpen(true);
  }

  async function saveProfile() {
    const response = await fetch("/api/discover/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: profileDraft }) });
    if (!response.ok) { setMsg("검색 설정을 저장하지 못했습니다."); return; }
    const data = await response.json() as { profile: DiscoveryProfile };
    setProfile(data.profile);
    setProfileDraft(data.profile);
    setProfileDirty(false);
    setMsg("발견 검색 설정을 저장했습니다.");
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
      <PageHeader title="발견" description="새로운 후보를 읽고, 다음 연구 행동을 바로 결정합니다." primaryAction={<button className="ui-button" disabled={busy || profileDirty} onClick={() => void runDiscovery()}>{profileDirty ? "설정을 먼저 저장" : busy ? "수집 요청 중…" : "지금 새로 찾기"}</button>} />
      <DiscoveryDirectionPanel profile={profileDraft} recommendations={recommendations} dirty={profileDirty} onChange={(next) => { setProfileDraft(next); setProfileDirty(true); }} onSave={() => void saveProfile()} />
      <div className="discovery-toolbar">
        <div className="filter-strip" aria-label="후보 상태 필터">
          {STATUS_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${statusFilter === filter.value ? " is-active" : ""}`} onClick={() => setStatusFilter(filter.value)}>{filter.label}</button>)}
        </div>
        <div className="filter-strip" aria-label="발견 방향 필터">{LANE_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${laneFilter === filter.value ? " is-active" : ""}`} onClick={() => setLaneFilter(filter.value)}>{filter.label}</button>)}</div>
        <span className="table-note">저장 키워드 {profile.original.keywords.length + profile.counter.keywords.length}개 · 관련도 0.65 이상 · 무료 원문/PDF · 최대 8개/회</span>
      </div>
      {msg && <p className="reservoir-message" role="status">{msg}</p>}
      {listError ? <StatusMessage kind="error" title={listError} action={<button className="ui-button-secondary" onClick={() => void load()}>다시 시도</button>} /> : <SplitWorkspace
        index={<SourceIndex title="발견 후보" items={candidates.map(toIndexItem)} selectedId={selectedId} onSelect={selectCandidate} />}
        reading={document ? <ReadingPane document={document} /> : <StatusMessage kind="empty" title="읽을 후보를 선택하세요" description="왼쪽 목록에서 후보를 고르면 실제 접근 링크와 함께 읽기 질문을 확인할 수 있습니다." />}
      />}
      {document && <DecisionBottomSheet actions={DISCOVERY_ACTIONS} document={document} open={decisionOpen} pending={busy} pendingAction={pendingAction} error={decisionError} onClose={() => setDecisionOpen(false)} onAction={(action) => void act(document.id, action)} />}
      <details className="discovery-settings">
        <summary>발견 범위와 수집 출처 조정</summary>
        <div className="discovery-settings__grid">
          <section><h2>RSS·Atom 피드</h2><p>공개 피드만 자동 수집합니다. 한 줄에 하나씩, 최대 6개입니다.</p><textarea value={feeds} onChange={(event) => setFeeds(event.target.value)} placeholder="https://some-journal.org/rss" /><button className="ui-button-secondary" onClick={() => void saveFeeds()}>피드 저장</button>{feedMsg && <span className="table-note">{feedMsg}</span>}</section>
        </div>
        <section className="discovery-sources"><h2>추천 출처 · 직접 읽기</h2><p>자동 수집 여부와 관계없이, 아래 링크에서 실제 자료를 확인할 수 있습니다.</p>{DISCOVERY_SOURCE_PRESETS.map((source: DiscoverySourcePreset) => <div className="discovery-source__row" key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a><span>{source.description} · {source.feedUrl ? "자동 수집" : source.id === "riss" ? "기관·검색 확인" : "직접 읽기"}</span></div>)}</section>
        {homepageProjects.length > 0 && <section className="discovery-sources"><h2>내 홈페이지 기반 출발점</h2><p>홈페이지에서 추출된 프로젝트가 발견 검색의 맥락으로 사용됩니다{homepageExtractedAt ? ` · 마지막 추출 ${new Date(homepageExtractedAt).toLocaleDateString("ko-KR")}` : ""}.</p>{homepageProjects.slice(0, 5).map((project) => <div className="discovery-source__row" key={project.slug}><a href={project.projectUrl} target="_blank" rel="noreferrer">{project.title} ↗</a><span>{project.year ?? "연도 미상"} · 이미지 {project.imageCount} · 영상 {project.videoCount}</span></div>)}</section>}
      </details>
    </div>
  );
}
