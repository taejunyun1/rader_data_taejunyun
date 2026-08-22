import { useCallback, useEffect, useMemo, useState } from "react";
import type { SourceAccess } from "../lib/sourceAccess";
import { deriveSourceAccess } from "../lib/sourceAccess";
import { formatDateKo } from "../lib/ui";
import { labelOf, ORIGIN_LABELS, PROVENANCE_LABELS, RELIABILITY_LABELS, SOURCE_KIND_LABELS } from "../lib/labels";
import PageHeader from "../components/layout/PageHeader";
import StatusMessage from "../components/ui/StatusMessage";
import DecisionBottomSheet from "../components/reading/DecisionBottomSheet";
import ReadingPane from "../components/reading/ReadingPane";
import type { DeepAnalysisViewModel } from "../components/reading/DeepAnalysisPanel";
import SourceIndex from "../components/reading/SourceIndex";
import SplitWorkspace from "../components/reading/SplitWorkspace";
import type { DecisionAction, ReadingDocument, SourceIndexItem } from "../components/reading/types";

interface ReservoirItem {
  id: string;
  title: string;
  kind: string;
  reliability: string;
  titleKo?: string | null;
  originalTitle?: string | null;
  status: string;
  origin: string | null;
  year: number | null;
  canonicalUrl: string | null;
  createdAt: string;
  topics: string | null;
  keywordCount: number;
  signalCount: number;
  markedForNextResearch?: number | boolean;
  decisionStatus?: "develop" | "keep" | "watch" | "ignore" | null;
}

interface SourceDetail {
  source: Record<string, unknown>;
  analysis: { summary?: string; keywords?: string[]; questions?: string[]; important_fragments?: string[] } | null;
  keywords: { keyword: string; weight: number }[];
  questions: { question: string; status: string }[];
  fragments: { text: string }[];
  versions: { version: number; char_count: number; created_at: string }[];
  signals: { action: string; created_at: string }[];
  deepAnalysis?: DeepAnalysisViewModel | null;
  deepAnalysisHistory?: { id: string; model?: string; createdAt: string; costUsd?: number }[];
}

const KINDS = ["", "PERSONAL_WORK", "PERSONAL_TEXT", "PAPER_ACADEMIC", "BOOK_ARTICLE", "ARTIST_ARTWORK", "TECHNICAL", "WEB", "NOTE", "DISCOVERY"];
const KIND_LABELS: Record<string, string> = { "": "전체 유형", ...SOURCE_KIND_LABELS };
const DECISION_FILTERS = [
  { value: "active", label: "활성 자료" },
  { value: "marked", label: "다음 리서치" },
  { value: "watching", label: "관찰 중" },
  { value: "ignored", label: "제외됨" },
  { value: "all", label: "전체 판단" },
] as const;

function safeTopics(value: string | null): string[] {
  if (!value) return [];
  try { return JSON.parse(value) as string[]; } catch { return []; }
}

function isMarkedForNextResearch(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function decisionLabel(status: ReservoirItem["decisionStatus"]): string | null {
  if (status === "develop") return "발전 반영";
  if (status === "keep") return "보관됨";
  if (status === "watch") return "관찰 중";
  if (status === "ignore") return "제외됨";
  return null;
}

function toIndexItem(item: ReservoirItem): SourceIndexItem {
  const status = decisionLabel(item.decisionStatus);
  const nextResearchTag = isMarkedForNextResearch(item.markedForNextResearch) ? "다음 리서치" : null;
  return { id: item.id, title: item.titleKo?.trim() || item.title, meta: [KIND_LABELS[item.kind] ?? item.kind, labelOf(RELIABILITY_LABELS, item.reliability), item.year].filter(Boolean).join(" · "), tags: [status, nextResearchTag, ...safeTopics(item.topics)].filter((tag): tag is string => Boolean(tag)), access: deriveSourceAccess({ href: item.canonicalUrl }) };
}

function toReadingDocument(detail: SourceDetail): ReadingDocument {
  const source = detail.source;
  const summary = detail.analysis?.summary ?? null;
  const fragments = detail.analysis?.important_fragments ?? detail.fragments.map((fragment) => fragment.text);
  const questions = detail.analysis?.questions ?? detail.questions.map((question) => question.question);
  const keywords = detail.analysis?.keywords ?? detail.keywords.map((keyword) => keyword.keyword);
  const rawTitle = String(source.title ?? "제목 없음");
  const translatedTitle = typeof source.titleKo === "string" ? source.titleKo.trim() : "";
  const title = translatedTitle || rawTitle;
  const originalTitle = typeof source.originalTitle === "string" ? source.originalTitle : translatedTitle && translatedTitle !== rawTitle ? rawTitle : undefined;
  const provenance = [labelOf(PROVENANCE_LABELS, source.provenanceClass, "원자료"), labelOf(RELIABILITY_LABELS, source.reliability)];
  const currentDecision = decisionLabel(source.decisionStatus as ReservoirItem["decisionStatus"]);
  if (currentDecision) provenance.push(currentDecision);
  if (isMarkedForNextResearch(source.markedForNextResearch)) provenance.push("다음 리서치에 포함");
  return {
    id: String(source.id),
    title,
    originalTitle,
    byline: [source.authors, source.year, labelOf(ORIGIN_LABELS, source.origin, "출처 정보 없음")].filter(Boolean).map(String).join(" · "),
    provenance: provenance.join(" · "),
    access: deriveSourceAccess({ href: source.canonicalUrl ? String(source.canonicalUrl) : null }),
    summary,
    fragments,
    questions,
    keywords,
  };
}

export default function ReservoirView({ focusSourceId, onFocusConsumed }: { focusSourceId?: string; onFocusConsumed?: () => void }) {
  const [items, setItems] = useState<ReservoirItem[]>([]);
  const [kindFilter, setKindFilter] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<(typeof DECISION_FILTERS)[number]["value"]>("active");
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);
  const [nextResearch, setNextResearch] = useState<{ markedCount: number; lastResearchAt: string | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [pendingAction, setPendingAction] = useState<DecisionAction["id"] | null>(null);
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ sourceId: string; title: string; matched: string; snippet: string }[] | null>(null);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [msg, setMsg] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [deepProfile, setDeepProfile] = useState<"precision" | "maximum">("precision");
  const [deepPending, setDeepPending] = useState(false);

  const load = useCallback(async () => {
    setListError("");
    const params = new URLSearchParams();
    if (kindFilter) params.set("kind", kindFilter);
    if (topicFilter) params.set("topic", topicFilter);
    params.set("decision", decisionFilter);
    try {
      const response = await fetch(`/api/reservoir${params.toString() ? `?${params}` : ""}`);
      if (!response.ok) throw new Error("list_failed");
      const data = await response.json() as { items?: ReservoirItem[]; nextResearch?: { markedCount: number; lastResearchAt: string | null } };
      setItems(data.items ?? []);
      setNextResearch(data.nextResearch ?? null);
    } catch { setListError("저장소 자료를 불러오지 못했습니다."); }
  }, [decisionFilter, kindFilter, topicFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!focusSourceId) return;
    void openDetail(focusSourceId);
    onFocusConsumed?.();
  }, [focusSourceId, onFocusConsumed]);
  useEffect(() => {
    fetch("/api/reservoir/topics").then((r) => r.json() as Promise<{ topics?: { topic: string; count: number }[] }>).then((data) => setTopics(data.topics ?? [])).catch(() => setTopics([]));
  }, [items]);

  async function openDetail(id: string, shouldOpen = true) {
    setSelectedId(id);
    setDetailError("");
    setSearchHits(null);
    setDecisionError("");
    if (shouldOpen) setDecisionOpen(true);
    try {
      const response = await fetch(`/api/reservoir/${id}`);
      if (!response.ok) throw new Error("detail_failed");
      const next = await response.json() as SourceDetail;
      setDetail(next);
      if (next.deepAnalysis?.profile) setDeepProfile(next.deepAnalysis.profile);
      await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: id, action: "view" }) });
    } catch { setDetail(null); setDecisionOpen(false); setDetailError("자료 상세 내용을 불러오지 못했습니다."); }
  }

  async function signal(action: DecisionAction["id"]) {
    if (!detail) return;
    const sourceId = String(detail.source.id);
    setActionPending(true);
    setPendingAction(action);
    setDecisionError("");
    try {
      const response = await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, action }) });
      if (!response.ok) throw new Error("signal_failed");
      setMsg(`${action === "develop" ? "발전시키기" : action === "keep" ? "다음 리서치까지 보관" : action === "watch" ? "관찰하기" : "제외하기"}로 기록했습니다.`);
      setDecisionOpen(false);
      if (action === "ignore") {
        setDetail(null);
        setSelectedId(null);
      } else {
        await openDetail(sourceId, false);
      }
      await load();
    } catch { setDecisionError("분류를 저장하지 못했습니다. 다시 시도해 주세요."); }
    finally { setActionPending(false); setPendingAction(null); }
  }

  async function runSearch() {
    if (!query.trim()) { setSearchHits(null); return; }
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) { setListError("검색 결과를 불러오지 못했습니다."); return; }
    const data = await response.json() as { hits?: { sourceId: string; title: string; matched: string; snippet: string }[] };
    setSearchHits(data.hits ?? []);
    setDetail(null);
    setSelectedId(null);
    setDecisionOpen(false);
  }

  async function reanalyze() {
    if (!detail) return;
    setActionPending(true);
    setMsg("다시 분석하는 중입니다.");
    try {
      const response = await fetch(`/api/inbox/retry/${String(detail.source.id)}?analyze=1`, { method: "POST" });
      const data = await response.json() as { status?: string; error?: string };
      setMsg(data.status === "analyzed" ? "분석을 완료했습니다." : `분석에 실패했습니다: ${String(data.error ?? "알 수 없는 오류").slice(0, 120)}`);
      await openDetail(String(detail.source.id));
    } catch { setMsg("분석을 다시 시작하지 못했습니다."); }
    finally { setActionPending(false); }
  }

  async function runDeepAnalysis() {
    if (!detail) return;
    setDeepPending(true);
    setMsg("심층 정리를 시작했습니다. 완료되면 상단 작업센터에서 결과를 확인할 수 있습니다.");
    try {
      const response = await fetch(`/api/reservoir/${String(detail.source.id)}/deep-analysis`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: deepProfile }) });
      const data = await response.json() as { error?: string; reused?: boolean };
      if (!response.ok) throw new Error(data.error ?? "심층 정리를 시작하지 못했습니다.");
      setMsg(data.reused ? "이미 진행 중인 심층 정리를 계속합니다." : "심층 정리를 시작했습니다. 완료되면 상단 작업센터에서 결과를 확인할 수 있습니다.");
    } catch (error) {
      setMsg(error instanceof Error && error.message === "monthly_budget_exhausted" ? "이번 달 AI 사용량 한도에 도달했습니다." : error instanceof Error ? error.message : "심층 정리를 시작하지 못했습니다.");
    } finally { setDeepPending(false); }
  }

  async function openDeepHistory(analysisId: string) {
    if (!detail) return;
    const response = await fetch(`/api/reservoir/${String(detail.source.id)}/deep-analysis/${analysisId}`);
    if (!response.ok) { setMsg("이전 심층 정리를 불러오지 못했습니다."); return; }
    const data = await response.json() as { analysis?: DeepAnalysisViewModel };
    if (data.analysis) setDetail((current) => current ? { ...current, deepAnalysis: data.analysis } : current);
  }

  const indexItems = useMemo(() => searchHits
    ? searchHits.map((hit) => ({ id: hit.sourceId, title: hit.title, meta: hit.matched, tags: hit.snippet ? [hit.snippet] : [], access: deriveSourceAccess({ href: null }) }))
    : items.map(toIndexItem), [items, searchHits]);
  const document = detail ? toReadingDocument(detail) : null;

  return (
    <div className="view-stack">
      <PageHeader title="저장소" description="보존된 자료를 읽고 다음 연구 행동을 기록합니다." primaryAction={<button className="ui-button" onClick={() => { setDetail(null); setSearchHits(null); }}>목록으로 돌아가기</button>} />
      <section className="reservoir-cycle-status" aria-label="다음 리서치 상태">
        <div><p className="reading-section__label">다음 리서치</p><strong>{nextResearch?.markedCount ?? 0}개 표시됨</strong></div>
        <p>{nextResearch?.lastResearchAt ? `마지막 착즙 ${formatDateKo(nextResearch.lastResearchAt)}` : "아직 착즙을 실행하지 않았습니다."} · 다음 착즙 실행 시 마크 갱신</p>
      </section>
      <div className="reservoir-toolbar">
        <input className="reservoir-search" value={query} placeholder="제목, 저자, 질문으로 검색" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }} />
        <button className="ui-button-secondary" onClick={() => void runSearch()}>검색</button>
        <div className="filter-strip">{KINDS.map((kind) => <button key={kind || "all"} className={`filter-button${kindFilter === kind ? " is-active" : ""}`} onClick={() => setKindFilter(kind)}>{KIND_LABELS[kind]}</button>)}</div>
        <div className="filter-strip" aria-label="판단 상태 필터">{DECISION_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${decisionFilter === filter.value ? " is-active" : ""}`} onClick={() => setDecisionFilter(filter.value)}>{filter.label}</button>)}</div>
      </div>
      {topics.length > 0 && <div className="topic-strip" aria-label="주제 필터">{topics.slice(0, 14).map((topic) => <button key={topic.topic} className={`topic-chip${topicFilter === topic.topic ? " is-active" : ""}`} onClick={() => setTopicFilter(topicFilter === topic.topic ? "" : topic.topic)}>{topic.topic} · {topic.count}</button>)}</div>}
      {msg && <p className="reservoir-message" role="status">{msg}</p>}
      {listError ? <StatusMessage kind="error" title={listError} action={<button className="ui-button-secondary" onClick={() => void load()}>다시 시도</button>} /> : <SplitWorkspace
        index={<SourceIndex title="저장소 자료" items={indexItems} selectedId={selectedId} onSelect={(id) => void openDetail(id)} />}
      reading={detailError ? <StatusMessage kind="error" title={detailError} action={<button className="ui-button-secondary" onClick={() => selectedId && void openDetail(selectedId)}>다시 시도</button>} /> : document ? <><div className="deep-analysis-controls" aria-label="심층 정리 실행"><label htmlFor="deep-analysis-profile">심층 정리 품질</label><select id="deep-analysis-profile" value={deepProfile} onChange={(event) => setDeepProfile(event.target.value as "precision" | "maximum")} disabled={deepPending}><option value="precision">정밀 · 긴 본문 구조화</option><option value="maximum">최고 정밀 · 논거와 연결 검토</option></select><button type="button" className="ui-button" onClick={() => void runDeepAnalysis()} disabled={deepPending}>{deepPending ? "심층 정리 중…" : "심층 정리하기"}</button></div><ReadingPane document={document} deepAnalysis={detail?.deepAnalysis} deepAnalysisHistory={detail?.deepAnalysisHistory} onOpenDeepHistory={(id) => void openDeepHistory(id)} /></> : <StatusMessage kind="empty" title="읽을 자료를 선택하세요" description="왼쪽 목록에서 자료를 고르면 원문과 분석 내용을 함께 읽을 수 있습니다." />}
      />}
      {document && <DecisionBottomSheet document={document} decisionStatus={detail?.source.decisionStatus as DecisionAction["id"] | null} open={decisionOpen} pending={actionPending} pendingAction={pendingAction} error={decisionError} onClose={() => setDecisionOpen(false)} onAction={(action) => void signal(action)} secondaryAction={{ label: "다시 분석하기", onClick: reanalyze }}><div className="source-detail-extra"><h3>자료 기록</h3><p>{detail?.versions.length ?? 0}개 버전 · {detail?.signals.length ?? 0}개 판단 기록</p></div></DecisionBottomSheet>}
      {searchHits && <p className="table-note">검색 결과 {searchHits.length}개 · 검색 결과를 선택하면 같은 읽기 화면에서 확인합니다.</p>}
      {detail && <p className="table-note">마지막 확인: {formatDateKo(String(detail.source.createdAt ?? ""))}</p>}
    </div>
  );
}
