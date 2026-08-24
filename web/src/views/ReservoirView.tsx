import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QualityStatus, TextScope } from "@radar/shared/ingestion";
import type { SourceAccess } from "../lib/sourceAccess";
import { deriveSourceAccess } from "../lib/sourceAccess";
import { formatDateKo } from "../lib/ui";
import { labelOf, ORIGIN_LABELS, PROVENANCE_LABELS, RELIABILITY_LABELS, SOURCE_KIND_LABELS } from "../lib/labels";
import { formatSourceTitle } from "../lib/sourcePresentation";
import PageHeader from "../components/layout/PageHeader";
import StatusMessage from "../components/ui/StatusMessage";
import DecisionBottomSheet, { DECISION_STATUS_LABELS } from "../components/reading/DecisionBottomSheet";
import ReadingActionBar from "../components/reading/ReadingActionBar";
import ReadingPane from "../components/reading/ReadingPane";
import type { DeepAnalysisViewModel } from "../components/reading/DeepAnalysisPanel";
import SourceIndex from "../components/reading/SourceIndex";
import SplitWorkspace from "../components/reading/SplitWorkspace";
import type { DecisionAction, ReadingDocument, SourceAcquisitionView, SourceIndexItem } from "../components/reading/types";

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
  acquisition?: SourceAcquisitionView | null;
  analysis: { summary?: string; keywords?: string[]; questions?: string[]; important_fragments?: string[] } | null;
  keywords: { keyword: string; weight: number }[];
  questions: { question: string; status: string }[];
  fragments: { text: string }[];
  versions: { version: number; char_count: number; created_at: string }[];
  signals: { action: string; created_at: string }[];
  deepAnalysis?: DeepAnalysisViewModel | null;
  deepAnalysisHistory?: { id: string; model?: string; createdAt: string; costUsd?: number }[];
}

interface DeepAnalysisResponse {
  error?: string;
  reused?: boolean;
  textScope?: TextScope;
  qualityStatus?: QualityStatus;
  charCount?: number;
}

interface DeepAnalysisBlock {
  error: "deep_analysis_text_not_ready";
  textScope: TextScope;
  qualityStatus: QualityStatus;
  charCount: number;
}

interface ReservoirFilterIntent {
  kind: string;
  topic: string;
  decision: (typeof DECISION_FILTERS)[number]["value"];
  generation: number;
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

function isDeepAnalysisBlock(response: DeepAnalysisResponse): response is DeepAnalysisBlock {
  return response.error === "deep_analysis_text_not_ready"
    && typeof response.textScope === "string"
    && typeof response.qualityStatus === "string"
    && typeof response.charCount === "number";
}

function deepAnalysisBlockReason(block: DeepAnalysisBlock): string {
  if (block.textScope === "METADATA_ONLY") {
    return "메타데이터만 저장되어 심층 정리를 시작할 수 없습니다. 원문을 다시 가져온 뒤 시도해 주세요.";
  }
  if (block.textScope === "PARTIAL") {
    return "본문이 일부만 수집되어 심층 정리를 시작할 수 없습니다. 원문을 다시 가져온 뒤 시도해 주세요.";
  }
  if (block.textScope === "EMPTY" || block.textScope === "UNKNOWN") {
    return "분석할 원문이 없어 심층 정리를 시작할 수 없습니다. 원문을 먼저 가져와 주세요.";
  }
  if (block.qualityStatus !== "READY") {
    return "원문 품질 확인이 필요해 심층 정리를 시작할 수 없습니다. 본문을 확인하거나 다시 가져와 주세요.";
  }
  return `본문이 ${block.charCount.toLocaleString("ko-KR")}자로 짧아 심층 정리를 시작할 수 없습니다. 1,000자 이상의 원문이 필요합니다.`;
}

function acquisitionBlockReason(acquisition: SourceAcquisitionView): string {
  const status = `원문 상태 ${acquisition.textScope} · 품질 ${acquisition.qualityStatus} · ${acquisition.charCount.toLocaleString("ko-KR")}자`;
  if (acquisition.textScope === "METADATA_ONLY") return `${status} — 메타데이터만 저장되어 심층 정리를 시작할 수 없습니다.`;
  if (acquisition.textScope === "PARTIAL") return `${status} — 본문이 일부만 수집되어 심층 정리를 시작할 수 없습니다.`;
  if (acquisition.textScope === "EMPTY" || acquisition.textScope === "UNKNOWN") return `${status} — 분석할 원문이 없어 심층 정리를 시작할 수 없습니다.`;
  if (acquisition.qualityStatus !== "READY") return `${status} — 원문 품질 확인이 필요해 심층 정리를 시작할 수 없습니다.`;
  return `${status} — 1,000자 이상의 정제 원문이 필요합니다.`;
}

function toIndexItem(item: ReservoirItem): SourceIndexItem {
  const status = decisionLabel(item.decisionStatus);
  const nextResearchTag = isMarkedForNextResearch(item.markedForNextResearch) ? "다음 리서치" : null;
  const displayTitle = formatSourceTitle(item.titleKo?.trim() || item.title);
  return { id: item.id, title: displayTitle, meta: [KIND_LABELS[item.kind] ?? item.kind, labelOf(RELIABILITY_LABELS, item.reliability), item.year].filter(Boolean).join(" · "), tags: [status, nextResearchTag, ...safeTopics(item.topics)].filter((tag): tag is string => Boolean(tag)), access: deriveSourceAccess({ href: item.canonicalUrl }) };
}

function toReadingDocument(detail: SourceDetail): ReadingDocument {
  const source = detail.source;
  const summary = detail.analysis?.summary ?? null;
  const fragments = detail.analysis?.important_fragments ?? detail.fragments.map((fragment) => fragment.text);
  const questions = detail.analysis?.questions ?? detail.questions.map((question) => question.question);
  const keywords = detail.analysis?.keywords ?? detail.keywords.map((keyword) => keyword.keyword);
  const rawTitle = formatSourceTitle(source.title);
  const translatedTitle = typeof source.titleKo === "string" ? formatSourceTitle(source.titleKo, "") : "";
  const title = translatedTitle || rawTitle;
  const originalTitle = typeof source.originalTitle === "string"
    ? formatSourceTitle(source.originalTitle)
    : translatedTitle && translatedTitle !== rawTitle
      ? rawTitle
      : undefined;
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
    acquisition: detail.acquisition,
    summary,
    fragments,
    questions,
    keywords,
  };
}

export default function ReservoirView({ onJobCreated, focusSourceId, onFocusConsumed }: { onJobCreated?: () => Promise<void>; focusSourceId?: string; onFocusConsumed?: () => void }) {
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
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<{ sourceId: string; title: string; matched: string; snippet: string }[] | null>(null);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [msg, setMsg] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [deepProfile, setDeepProfile] = useState<"precision" | "maximum">("precision");
  const [deepPending, setDeepPending] = useState(false);
  const [deepBlock, setDeepBlock] = useState<DeepAnalysisBlock | null>(null);
  const interactionRequest = useRef(0);
  const listRequest = useRef(0);
  const actionRequest = useRef(0);
  const deepAnalysisRequest = useRef(0);
  const deepHistoryRequest = useRef(0);
  const topicRequest = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const filterIntentRef = useRef<ReservoirFilterIntent>({ kind: "", topic: "", decision: "active", generation: 0 });

  const isCurrentFilterIntent = useCallback((intent: ReservoirFilterIntent): boolean => (
    filterIntentRef.current.kind === intent.kind
    && filterIntentRef.current.topic === intent.topic
    && filterIntentRef.current.decision === intent.decision
    && filterIntentRef.current.generation === intent.generation
  ), []);

  const updateFilters = useCallback((nextValues: Pick<ReservoirFilterIntent, "kind" | "topic" | "decision">) => {
    const current = filterIntentRef.current;
    if (current.kind === nextValues.kind && current.topic === nextValues.topic && current.decision === nextValues.decision) return current;
    const next = { ...nextValues, generation: current.generation + 1 };
    filterIntentRef.current = next;
    listRequest.current += 1;
    topicRequest.current += 1;
    actionRequest.current += 1;
    setActionPending(false);
    setPendingAction(null);
    setKindFilter(next.kind);
    setTopicFilter(next.topic);
    setDecisionFilter(next.decision);
    return next;
  }, []);

  const load = useCallback(async (intent: ReservoirFilterIntent = filterIntentRef.current) => {
    if (!isCurrentFilterIntent(intent)) return;
    const requestId = listRequest.current + 1;
    listRequest.current = requestId;
    topicRequest.current += 1;
    setListError("");
    const params = new URLSearchParams();
    if (intent.kind) params.set("kind", intent.kind);
    if (intent.topic) params.set("topic", intent.topic);
    params.set("decision", intent.decision);
    try {
      const response = await fetch(`/api/reservoir${params.toString() ? `?${params}` : ""}`);
      if (!response.ok) throw new Error("list_failed");
      const data = await response.json() as { items?: ReservoirItem[]; nextResearch?: { markedCount: number; lastResearchAt: string | null } };
      if (listRequest.current !== requestId || !isCurrentFilterIntent(intent)) return;
      const nextItems = data.items ?? [];
      setItems(nextItems);
      setNextResearch(data.nextResearch ?? null);
      if (selectedIdRef.current && !nextItems.some((item) => item.id === selectedIdRef.current)) {
        startInteraction();
        resetSelection();
      }
    } catch {
      if (listRequest.current === requestId && isCurrentFilterIntent(intent)) setListError("저장소 자료를 불러오지 못했습니다.");
    }
  }, [isCurrentFilterIntent]);

  useEffect(() => { void load(); }, [decisionFilter, kindFilter, load, topicFilter]);
  useEffect(() => {
    if (!focusSourceId) return;
    void openDetail(focusSourceId);
    onFocusConsumed?.();
  }, [focusSourceId, onFocusConsumed]);
  useEffect(() => {
    const requestId = topicRequest.current + 1;
    topicRequest.current = requestId;
    const controller = new AbortController();
    fetch("/api/reservoir/topics", { signal: controller.signal })
      .then((r) => r.json() as Promise<{ topics?: { topic: string; count: number }[] }>)
      .then((data) => {
        if (topicRequest.current === requestId) setTopics(data.topics ?? []);
      })
      .catch((error) => {
        if (topicRequest.current !== requestId || (error instanceof Error && error.name === "AbortError")) return;
        setTopics([]);
      });
    return () => controller.abort();
  }, [items]);

  function startInteraction({ preserveAction = false }: { preserveAction?: boolean } = {}) {
    interactionRequest.current += 1;
    deepAnalysisRequest.current += 1;
    deepHistoryRequest.current += 1;
    setDeepPending(false);
    if (!preserveAction) {
      actionRequest.current += 1;
      setActionPending(false);
      setPendingAction(null);
    }
    return interactionRequest.current;
  }

  function resetSelection() {
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError("");
    setDecisionOpen(false);
    setDecisionError("");
    setDeepBlock(null);
  }

  function clearSelection() {
    startInteraction();
    resetSelection();
  }

  async function openDetail(id: string, { preserveAction = false }: { preserveAction?: boolean } = {}) {
    const requestId = startInteraction({ preserveAction });
    selectedIdRef.current = id;
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setDecisionOpen(false);
    setDetailError("");
    setSearchHits(null);
    setDecisionError("");
    setDeepBlock(null);
    try {
      const response = await fetch(`/api/reservoir/${id}`);
      if (!response.ok) throw new Error("detail_failed");
      const next = await response.json() as SourceDetail;
      if (interactionRequest.current !== requestId) return requestId;
      setDetail(next);
      setDetailLoading(false);
      if (next.deepAnalysis?.profile) setDeepProfile(next.deepAnalysis.profile);
    } catch {
      if (interactionRequest.current !== requestId) return requestId;
      setDetail(null);
      setDetailLoading(false);
      setDecisionOpen(false);
      setDetailError("자료 상세 내용을 불러오지 못했습니다.");
      return requestId;
    }
    void fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId: id, action: "view" }) }).catch(() => undefined);
    return requestId;
  }

  async function signal(action: DecisionAction["id"]) {
    if (!detail) return;
    const sourceId = String(detail.source.id);
    const requestId = interactionRequest.current;
    const filterIntent = filterIntentRef.current;
    const actionRequestId = actionRequest.current + 1;
    actionRequest.current = actionRequestId;
    const isCurrent = () => interactionRequest.current === requestId
      && actionRequest.current === actionRequestId
      && isCurrentFilterIntent(filterIntent);
    setActionPending(true);
    setPendingAction(action);
    setDecisionError("");
    try {
      const response = await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, action }) });
      if (!response.ok) throw new Error("signal_failed");
      if (!isCurrent()) return;
      setMsg(`${action === "develop" ? "발전시키기" : action === "keep" ? "다음 리서치까지 보관" : action === "watch" ? "관찰하기" : "제외하기"}로 기록했습니다.`);
      setDecisionOpen(false);
      if (action === "ignore") {
        clearSelection();
      } else {
        const detailRequestId = await openDetail(sourceId, { preserveAction: true });
        if (actionRequest.current !== actionRequestId || interactionRequest.current !== detailRequestId) return;
      }
      await load(filterIntent);
    } catch {
      if (isCurrent()) setDecisionError("분류를 저장하지 못했습니다. 다시 시도해 주세요.");
    }
    finally {
      if (actionRequest.current === actionRequestId) {
        setActionPending(false);
        setPendingAction(null);
      }
    }
  }

  async function runSearch() {
    const requestId = startInteraction();
    if (!query.trim()) { setSearchHits(null); return; }
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error("search_failed");
      const data = await response.json() as { hits?: { sourceId: string; title: string; matched: string; snippet: string }[] };
      if (interactionRequest.current !== requestId) return;
      resetSelection();
      setSearchHits(data.hits ?? []);
    } catch {
      if (interactionRequest.current === requestId) setListError("검색 결과를 불러오지 못했습니다.");
    }
  }

  async function reanalyze() {
    if (!detail) return;
    const sourceId = String(detail.source.id);
    const requestId = interactionRequest.current;
    const actionRequestId = actionRequest.current + 1;
    actionRequest.current = actionRequestId;
    const isCurrent = () => interactionRequest.current === requestId && actionRequest.current === actionRequestId;
    setActionPending(true);
    setMsg("다시 분석하는 중입니다.");
    try {
      const response = await fetch(`/api/inbox/retry/${sourceId}?analyze=1`, { method: "POST" });
      const data = await response.json() as { status?: string; error?: string };
      if (!isCurrent()) return;
      setMsg(data.status === "analyzed" ? "분석을 완료했습니다." : `분석에 실패했습니다: ${String(data.error ?? "알 수 없는 오류").slice(0, 120)}`);
      const detailRequestId = await openDetail(sourceId, { preserveAction: true });
      if (actionRequest.current !== actionRequestId || interactionRequest.current !== detailRequestId) return;
    } catch {
      if (isCurrent()) setMsg("분석을 다시 시작하지 못했습니다.");
    }
    finally {
      if (actionRequest.current === actionRequestId) setActionPending(false);
    }
  }

  async function refetch() {
    if (!detail || typeof detail.source.canonicalUrl !== "string" || !detail.source.canonicalUrl.trim()) return;
    const sourceId = String(detail.source.id);
    const requestId = interactionRequest.current;
    const actionRequestId = actionRequest.current + 1;
    actionRequest.current = actionRequestId;
    const isCurrent = () => interactionRequest.current === requestId && actionRequest.current === actionRequestId;
    setActionPending(true);
    setMsg("원문 수집을 요청하는 중입니다.");
    try {
      const response = await fetch(`/api/inbox/retry/${sourceId}?fetch=1`, { method: "POST" });
      const data = await response.json() as { reused?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? "원문 수집을 시작하지 못했습니다.");
      if (!isCurrent()) return;
      await onJobCreated?.();
      if (!isCurrent()) return;
      setMsg(data.reused ? "이미 진행 중인 원문 수집을 계속합니다." : "원문 수집을 시작했습니다. 작업센터에서 진행 상태를 확인하세요.");
    } catch (error) {
      if (isCurrent()) setMsg(error instanceof Error ? error.message : "원문 수집을 시작하지 못했습니다.");
    } finally {
      if (actionRequest.current === actionRequestId) setActionPending(false);
    }
  }

  async function runDeepAnalysis() {
    if (!detail || detail.acquisition?.canDeepAnalyze === false) return;
    const sourceId = String(detail.source.id);
    const interactionRequestId = interactionRequest.current;
    const requestId = deepAnalysisRequest.current + 1;
    deepAnalysisRequest.current = requestId;
    const isCurrent = () => interactionRequest.current === interactionRequestId && deepAnalysisRequest.current === requestId;
    setDeepPending(true);
    setMsg("심층 정리를 시작했습니다. 완료되면 상단 작업센터에서 결과를 확인할 수 있습니다.");
    try {
      const response = await fetch(`/api/reservoir/${sourceId}/deep-analysis`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: deepProfile }) });
      const data = await response.json() as DeepAnalysisResponse;
      if (!isCurrent()) return;
      if (response.status === 422 && isDeepAnalysisBlock(data)) {
        setDeepBlock(data);
        setMsg("");
        return;
      }
      if (!response.ok) throw new Error(data.error ?? "심층 정리를 시작하지 못했습니다.");
      await onJobCreated?.();
      if (!isCurrent()) return;
      setMsg(data.reused ? "이미 진행 중인 심층 정리를 계속합니다." : "심층 정리를 시작했습니다. 완료되면 상단 작업센터에서 결과를 확인할 수 있습니다.");
    } catch (error) {
      if (isCurrent()) setMsg(error instanceof Error && error.message === "monthly_budget_exhausted" ? "이번 달 AI 사용량 한도에 도달했습니다." : error instanceof Error ? error.message : "심층 정리를 시작하지 못했습니다.");
    } finally {
      if (deepAnalysisRequest.current === requestId) setDeepPending(false);
    }
  }

  async function openDeepHistory(analysisId: string) {
    if (!detail) return;
    const sourceId = String(detail.source.id);
    const interactionRequestId = interactionRequest.current;
    const requestId = deepHistoryRequest.current + 1;
    deepHistoryRequest.current = requestId;
    try {
      const response = await fetch(`/api/reservoir/${sourceId}/deep-analysis/${analysisId}`);
      if (!response.ok) {
        if (interactionRequest.current === interactionRequestId && deepHistoryRequest.current === requestId) setMsg("이전 심층 정리를 불러오지 못했습니다.");
        return;
      }
      const data = await response.json() as { analysis?: DeepAnalysisViewModel };
      if (interactionRequest.current !== interactionRequestId || deepHistoryRequest.current !== requestId || !data.analysis) return;
      setDetail((current) => current && String(current.source.id) === sourceId ? { ...current, deepAnalysis: data.analysis } : current);
    } catch {
      if (interactionRequest.current === interactionRequestId && deepHistoryRequest.current === requestId) setMsg("이전 심층 정리를 불러오지 못했습니다.");
    }
  }

  const indexItems = useMemo(() => searchHits
    ? searchHits.map((hit) => ({ id: hit.sourceId, title: hit.title, meta: hit.matched, tags: hit.snippet ? [hit.snippet] : [], access: deriveSourceAccess({ href: null }) }))
    : items.map(toIndexItem), [items, searchHits]);
  const document = detail ? toReadingDocument(detail) : null;
  const acquisitionDeepBlocked = detail?.acquisition?.canDeepAnalyze === false;
  const deepBlockReason = acquisitionDeepBlocked && detail?.acquisition
    ? acquisitionBlockReason(detail.acquisition)
    : deepBlock
      ? deepAnalysisBlockReason(deepBlock)
      : null;
  const canonicalUrl = typeof detail?.source.canonicalUrl === "string" && detail.source.canonicalUrl.trim()
    ? detail.source.canonicalUrl
    : null;
  const deepDisabled = acquisitionDeepBlocked || Boolean(deepBlock);

  return (
    <div className="view-stack">
      <PageHeader title="저장소" description="보존된 자료를 읽고 다음 연구 행동을 기록합니다." />
      <section className="reservoir-cycle-status" aria-label="다음 리서치 상태">
        <div><p className="reading-section__label">다음 리서치</p><strong>{nextResearch?.markedCount ?? 0}개 표시됨</strong></div>
        <p>{nextResearch?.lastResearchAt ? `마지막 착즙 ${formatDateKo(nextResearch.lastResearchAt)}` : "아직 착즙을 실행하지 않았습니다."} · 다음 착즙 실행 시 마크 갱신</p>
      </section>
      <div className="reservoir-toolbar">
        <input className="reservoir-search" value={query} placeholder="제목, 저자, 질문으로 검색" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }} />
        <button className="ui-button-secondary" onClick={() => void runSearch()}>검색</button>
        <div className="filter-strip">{KINDS.map((kind) => <button key={kind || "all"} className={`filter-button${kindFilter === kind ? " is-active" : ""}`} onClick={() => updateFilters({ kind, topic: topicFilter, decision: decisionFilter })}>{KIND_LABELS[kind]}</button>)}</div>
        <div className="filter-strip" aria-label="판단 상태 필터">{DECISION_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${decisionFilter === filter.value ? " is-active" : ""}`} onClick={() => updateFilters({ kind: kindFilter, topic: topicFilter, decision: filter.value })}>{filter.label}</button>)}</div>
      </div>
      {topics.length > 0 && <div className="topic-strip" aria-label="주제 필터">{topics.slice(0, 14).map((topic) => <button key={topic.topic} className={`topic-chip${topicFilter === topic.topic ? " is-active" : ""}`} onClick={() => updateFilters({ kind: kindFilter, topic: topicFilter === topic.topic ? "" : topic.topic, decision: decisionFilter })}>{topic.topic} · {topic.count}</button>)}</div>}
      {msg && <p className="reservoir-message" role="status">{msg}</p>}
      {listError ? <StatusMessage kind="error" title={listError} action={<button className="ui-button-secondary" onClick={() => void load()}>다시 시도</button>} /> : <SplitWorkspace
        readingKey={selectedId}
        mobilePane={selectedId ? "reading" : "index"}
        index={<SourceIndex title="저장소 자료" items={indexItems} selectedId={selectedId} onSelect={(id) => void openDetail(id)} />}
      reading={detailError ? <><ReadingActionBar message="상세 내용을 불러오지 못했습니다." onBack={clearSelection} /><StatusMessage kind="error" title={detailError} action={<button className="ui-button-secondary" onClick={() => selectedId && void openDetail(selectedId)}>다시 시도</button>} /></> : detailLoading ? <><ReadingActionBar message="자료 상세 내용을 불러오는 중…" onBack={clearSelection} /><StatusMessage kind="loading" title="자료 상세 내용을 불러오는 중…" description="원문과 분석 내용을 준비하고 있습니다." /></> : document ? <><ReadingActionBar statusLabel={detail?.source.decisionStatus ? DECISION_STATUS_LABELS[detail.source.decisionStatus as DecisionAction["id"]] : null} pending={actionPending} onBack={clearSelection} onOpenDecision={() => setDecisionOpen(true)} /><div className="deep-analysis-controls" aria-label="심층 정리 실행"><label htmlFor="deep-analysis-profile">심층 정리 품질</label><select id="deep-analysis-profile" value={deepProfile} onChange={(event) => setDeepProfile(event.target.value as "precision" | "maximum")} disabled={deepPending || deepDisabled}><option value="precision">정밀 · 긴 본문 구조화</option><option value="maximum">최고 정밀 · 논거와 연결 검토</option></select><button type="button" className="ui-button" onClick={() => void runDeepAnalysis()} disabled={deepPending || deepDisabled}>{deepDisabled ? "원문 수집 필요" : deepPending ? "심층 정리 중…" : "심층 정리하기"}</button></div>{deepBlockReason && <p className="deep-analysis-blocked" role="status">{deepBlockReason}</p>}<ReadingPane document={document} deepAnalysis={detail?.deepAnalysis} deepAnalysisHistory={detail?.deepAnalysisHistory} onOpenDeepHistory={(id) => void openDeepHistory(id)} /></> : <StatusMessage kind="empty" title="읽을 자료를 선택하세요" description="왼쪽 목록에서 자료를 고르면 원문과 분석 내용을 함께 읽을 수 있습니다." />}
      />}
      {document && <DecisionBottomSheet document={document} decisionStatus={detail?.source.decisionStatus as DecisionAction["id"] | null} open={decisionOpen} pending={actionPending} pendingAction={pendingAction} error={decisionError} onClose={() => setDecisionOpen(false)} onAction={(action) => void signal(action)} secondaryAction={{ label: "다시 분석하기", onClick: reanalyze }}><div className="source-detail-extra"><div className="source-detail-extra__heading"><h3>자료 기록</h3><button className="ui-button-secondary" type="button" disabled={actionPending || !canonicalUrl} onClick={() => void refetch()}>다시 가져오기</button></div><p>{detail?.versions.length ?? 0}개 버전 · {detail?.signals.length ?? 0}개 판단 기록</p>{!canonicalUrl && <p>원문 주소가 없어 다시 가져올 수 없습니다.</p>}</div></DecisionBottomSheet>}
      {searchHits && <p className="table-note">검색 결과 {searchHits.length}개 · 검색 결과를 선택하면 같은 읽기 화면에서 확인합니다.</p>}
      {detail && <p className="table-note">마지막 확인: {formatDateKo(String(detail.source.createdAt ?? ""))}</p>}
    </div>
  );
}
