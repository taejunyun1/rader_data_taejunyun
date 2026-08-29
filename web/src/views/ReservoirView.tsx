import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { QualityStatus, TextScope } from "@radar/shared/ingestion";
import type { PdfVisualExtractionCapability, VisualAssetSummary, VisualExtractionRunSummary } from "@radar/shared";
import type { SourceAccess } from "../lib/sourceAccess";
import { deriveSourceAccess } from "../lib/sourceAccess";
import { formatDateKo } from "../lib/ui";
import { labelOf, ORIGIN_LABELS, PROVENANCE_LABELS, QUALITY_STATUS_LABELS, RELIABILITY_LABELS, SOURCE_KIND_LABELS } from "../lib/labels";
import { formatSourceTitle } from "../lib/sourcePresentation";
import PageHeader from "../components/layout/PageHeader";
import StatusMessage from "../components/ui/StatusMessage";
import DecisionBottomSheet, { DECISION_STATUS_LABELS } from "../components/reading/DecisionBottomSheet";
import SourceDeleteDialog from "../components/reservoir/SourceDeleteDialog";
import { useModalAccessibility } from "../components/reading/modalAccessibility";
import ReadingActionBar from "../components/reading/ReadingActionBar";
import ReadingPane from "../components/reading/ReadingPane";
import type { DeepAnalysisViewModel } from "../components/reading/DeepAnalysisPanel";
import SourceIndex from "../components/reading/SourceIndex";
import SplitWorkspace from "../components/reading/SplitWorkspace";
import VisualAssetPanel from "../components/visual/VisualAssetPanel";
import PdfExtractionProgress from "../components/visual/PdfExtractionProgress";
import PdfOriginalRecovery from "../components/visual/PdfOriginalRecovery";
import { type PdfVisualExtractionResult } from "../lib/pdfVisualExtraction";
import { startPdfVisualExtractionTask, stopPdfVisualExtractionTask, usePdfVisualExtractionTasks } from "../lib/pdfVisualExtractionManager";
import type { DecisionAction, ReadingDocument, SourceAcquisitionView, SourceIndexItem } from "../components/reading/types";
import type { ResearchJob } from "@radar/shared/discovery";

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
  activeVersionId?: string | null;
  createdAt: string;
  topics: string | null;
  keywordCount: number;
  signalCount: number;
  markedForNextResearch?: number | boolean;
  decisionStatus?: "develop" | "keep" | "watch" | "ignore" | null;
}

interface SourceDetail {
  source: Record<string, unknown> & { inputFormat?: string | null; activeVersionId?: string | null };
  deletion: {
    sourceId: string;
    title: string;
    mergeRole: "NONE" | "CANONICAL" | "MEMBER";
    mergeMemberCount: number;
  };
  acquisition?: SourceAcquisitionView | null;
  pdfExtraction?: PdfVisualExtractionResult | null;
  visualExtractionCapability?: PdfVisualExtractionCapability;
  visualExtractionRun?: VisualExtractionRunSummary | null;
  analysis: { summary?: string; keywords?: string[]; questions?: string[]; important_fragments?: string[] } | null;
  keywords: { keyword: string; weight: number }[];
  questions: { question: string; status: string }[];
  fragments: { text: string }[];
  versions: { version: number; char_count: number; created_at: string }[];
  signals: { action: string; created_at: string }[];
  deepAnalysis?: DeepAnalysisViewModel | null;
  deepAnalysisHistory?: { id: string; model?: string; createdAt: string; costUsd?: number }[];
  visuals?: VisualAssetSummary[];
}

interface DeepAnalysisResponse {
  error?: string;
  reused?: boolean;
  job?: Pick<ResearchJob, "id">;
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

type ReservoirDecisionRetry =
  | { kind: "signal"; action: DecisionAction["id"] }
  | { kind: "reanalyze" }
  | { kind: "refetch" };

interface ReservoirFilterIntent {
  kind: string;
  topic: string;
  decision: (typeof DECISION_FILTERS)[number]["value"];
  generation: number;
}

function useCompactViewport() {
  const [compact, setCompact] = useState(() => window.innerWidth <= 900);
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
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

function acquisitionBlockReason(acquisition: SourceAcquisitionView, canRefetch: boolean, inputFormat?: string | null): string {
  const scopeLabel = acquisition.textScope === "FULLTEXT"
    ? "원문 전체"
    : acquisition.textScope === "PARTIAL"
      ? "원문 일부"
      : acquisition.textScope === "METADATA_ONLY"
        ? "메타데이터만"
        : acquisition.textScope === "EMPTY"
          ? "본문 없음"
          : "원문 상태 확인 필요";
  const status = `${scopeLabel} · ${labelOf(QUALITY_STATUS_LABELS, acquisition.qualityStatus)} · ${acquisition.charCount.toLocaleString("ko-KR")}자`;
  const localRepair = inputFormat === "OBSIDIAN_MARKDOWN"
    ? "받은 자료에서 본문을 보강하거나 Obsidian 동기화를 다시 실행해 주세요."
    : "받은 자료에서 원문을 보강해 주세요.";
  if (acquisition.textScope === "METADATA_ONLY") return `${status} — ${canRefetch ? "원문을 다시 가져온 뒤 심층 정리를 시작할 수 있습니다." : localRepair}`;
  if (acquisition.textScope === "PARTIAL") return `${status} — ${canRefetch ? "본문이 일부만 수집되었습니다. 원문을 다시 가져와 주세요." : localRepair}`;
  if (acquisition.textScope === "EMPTY" || acquisition.textScope === "UNKNOWN") return `${status} — ${canRefetch ? "분석할 원문을 먼저 가져와 주세요." : localRepair}`;
  if (acquisition.qualityStatus !== "READY") return `${status} — 원문 품질 확인이 필요해 심층 정리를 시작할 수 없습니다.`;
  return `${status} — 1,000자 이상의 정제 원문이 필요합니다.`;
}

function sourceDeleteErrorMessage(code: string): string {
  if (code === "source_delete_confirmation_mismatch") return "자료 제목이 변경됐습니다. 상세 화면을 다시 불러와 주세요.";
  if (code === "source_delete_active_work") return "이 자료의 처리 작업이 진행 중입니다. 작업이 끝난 뒤 다시 시도해 주세요.";
  if (code === "source_delete_state_changed") return "병합 또는 자료 상태가 변경됐습니다. 상세 화면을 다시 불러와 주세요.";
  if (code === "source_delete_r2_failed") return "원본 저장소 정리에 실패했습니다. 자료는 삭제되지 않았습니다.";
  if (code === "source_not_found") return "이미 삭제된 자료입니다.";
  return "자료를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.";
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

interface ReservoirViewProps {
  onJobCreated?: () => Promise<void>;
  focusSourceId?: string;
  focusExtractionRunId?: string;
  onFocusConsumed?: () => void;
  jobs?: ResearchJob[];
}

export default function ReservoirView({ onJobCreated, focusSourceId, focusExtractionRunId, onFocusConsumed, jobs = [] }: ReservoirViewProps) {
  const [items, setItems] = useState<ReservoirItem[]>([]);
  const [kindFilter, setKindFilter] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<(typeof DECISION_FILTERS)[number]["value"]>("active");
  const [topics, setTopics] = useState<{ topic: string; count: number }[]>([]);
  const [nextResearch, setNextResearch] = useState<{ markedCount: number; lastResearchAt: string | null } | null>(null);
  const [unassignedVisuals, setUnassignedVisuals] = useState<VisualAssetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const [decisionRetry, setDecisionRetry] = useState<ReservoirDecisionRetry | null>(null);
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
  const [deepJobId, setDeepJobId] = useState<string | null>(null);
  const [deepBlock, setDeepBlock] = useState<DeepAnalysisBlock | null>(null);
  const [pdfExtraction, setPdfExtraction] = useState<PdfVisualExtractionResult | null>(null);
  const [pdfExtractionPending, setPdfExtractionPending] = useState(false);
  const [pdfSheetOpen, setPdfSheetOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const interactionRequest = useRef(0);
  const listRequest = useRef(0);
  const actionRequest = useRef(0);
  const deepAnalysisRequest = useRef(0);
  const deepCompletionRef = useRef<string | null>(null);
  const visualCompletionRef = useRef<string | null>(null);
  const deepHistoryRequest = useRef(0);
  const topicRequest = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const pdfSheetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pdfSheetLayerRef = useRef<HTMLDivElement | null>(null);
  const pdfSheetDialogRef = useRef<HTMLElement | null>(null);
  const pdfSheetCloseRef = useRef<HTMLButtonElement | null>(null);
  const filterIntentRef = useRef<ReservoirFilterIntent>({ kind: "", topic: "", decision: "active", generation: 0 });
  const deleteRequest = useRef(0);
  const compactViewport = useCompactViewport();
  const pdfPreparationTasks = usePdfVisualExtractionTasks();

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
    fetch("/api/visual-assets?unassigned=1")
      .then((response) => response.ok ? response.json() as Promise<{ items?: VisualAssetSummary[] }> : Promise.reject(new Error("visual_list_failed")))
      .then((data) => setUnassignedVisuals(data.items ?? []))
      .catch(() => setUnassignedVisuals([]));
  }, []);
  useEffect(() => {
    if (!focusSourceId) return;
    void openDetail(focusSourceId, { extractionRunId: focusExtractionRunId });
    onFocusConsumed?.();
  }, [focusExtractionRunId, focusSourceId, onFocusConsumed]);
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
    setDeepJobId(null);
    if (!preserveAction) {
      actionRequest.current += 1;
      setActionPending(false);
      setPendingAction(null);
      setDecisionRetry(null);
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
    setDecisionRetry(null);
    setDeepBlock(null);
    setPdfExtraction(null);
    setPdfExtractionPending(false);
    setPdfSheetOpen(false);
    setDeleteOpen(false);
    setDeletePending(false);
    setDeleteError("");
    deleteRequest.current += 1;
  }

  function clearSelection() {
    startInteraction();
    resetSelection();
  }

  async function openDetail(id: string, { preserveAction = false, extractionRunId }: { preserveAction?: boolean; extractionRunId?: string } = {}) {
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
      let next = await response.json() as SourceDetail;
      if (extractionRunId && next.visualExtractionRun?.id !== extractionRunId) {
        const runResponse = await fetch(`/api/visual-extraction/runs/${encodeURIComponent(extractionRunId)}`);
        if (runResponse.ok) {
          const runData = await runResponse.json() as { run?: VisualExtractionRunSummary };
          if (runData.run?.id === extractionRunId && runData.run.parentSourceId === id) {
            next = { ...next, visualExtractionRun: runData.run };
          }
        }
      }
      if (interactionRequest.current !== requestId) return requestId;
      setDetail(next);
      setDetailLoading(false);
      setPdfExtraction(next.pdfExtraction ?? null);
      setPdfSheetOpen(false);
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

  useEffect(() => {
    if (!detail) return;
    const sourceId = String(detail.source.id);
    const sourceVersionId = typeof detail.source.activeVersionId === "string" ? detail.source.activeVersionId : "";
    const task = pdfPreparationTasks.find((candidate) => candidate.sourceId === sourceId && candidate.sourceVersionId === sourceVersionId);
    if (!task) return;
    setPdfExtraction((current) => ({
      runId: task.runId || current?.runId || "",
      status: task.status,
      totalPages: task.totalPages || current?.totalPages || 0,
      uploadedPages: task.uploadedPages,
      remainingPages: Math.max(0, task.totalPages - task.uploadedPages),
      nextPageNumber: task.uploadedPages + 1 <= task.totalPages ? task.uploadedPages + 1 : null,
    }));
    setPdfExtractionPending(["PREPARING", "UPLOADING", "FINALIZING"].includes(task.status));
  }, [detail, pdfPreparationTasks]);

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
    setDecisionRetry({ kind: "signal", action });
    setDecisionOpen(false);
    try {
      const response = await fetch("/api/signals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceId, action }) });
      if (!response.ok) throw new Error("signal_failed");
      if (!isCurrent()) return;
      setMsg(`${action === "develop" ? "발전시키기" : action === "keep" ? "다음 리서치까지 보관" : action === "watch" ? "관찰하기" : "제외하기"}로 기록했습니다.`);
      if (action === "ignore") {
        clearSelection();
      } else {
        const detailRequestId = await openDetail(sourceId, { preserveAction: true });
        if (actionRequest.current !== actionRequestId || interactionRequest.current !== detailRequestId) return;
      }
      setDecisionRetry(null);
      await load(filterIntent);
    } catch {
      if (isCurrent()) {
        setDecisionError("분류를 저장하지 못했습니다. 다시 시도해 주세요.");
        setMsg("");
      }
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
    setDecisionRetry({ kind: "reanalyze" });
    setDecisionError("");
    setMsg("다시 분석하는 중입니다.");
    setDecisionOpen(false);
    try {
      const response = await fetch(`/api/inbox/retry/${sourceId}?analyze=1`, { method: "POST" });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "분석을 다시 시작하지 못했습니다.");
      if (!isCurrent()) return;
      setMsg(data.status === "analyzed" ? "분석을 완료했습니다." : `분석에 실패했습니다: ${String(data.error ?? "알 수 없는 오류").slice(0, 120)}`);
      const detailRequestId = await openDetail(sourceId, { preserveAction: true });
      if (actionRequest.current !== actionRequestId || interactionRequest.current !== detailRequestId) return;
      setDecisionRetry(null);
    } catch {
      if (isCurrent()) {
        setDecisionError("분석을 다시 시작하지 못했습니다.");
        setMsg("");
      }
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
    setDecisionRetry({ kind: "refetch" });
    setDecisionError("");
    setMsg("원문 수집을 요청하는 중입니다.");
    setDecisionOpen(false);
    try {
      const response = await fetch(`/api/inbox/retry/${sourceId}?fetch=1`, { method: "POST" });
      const data = await response.json() as { reused?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? "원문 수집을 시작하지 못했습니다.");
      if (!isCurrent()) return;
      await onJobCreated?.();
      if (!isCurrent()) return;
      setMsg(data.reused ? "이미 진행 중인 원문 수집을 계속합니다." : "원문 수집을 시작했습니다. 작업센터에서 진행 상태를 확인하세요.");
      setDecisionRetry(null);
    } catch (error) {
      if (isCurrent()) {
        setDecisionError(error instanceof Error ? error.message : "원문 수집을 시작하지 못했습니다.");
        setMsg("");
      }
    } finally {
      if (actionRequest.current === actionRequestId) setActionPending(false);
    }
  }

  async function deleteCurrentSource(confirmTitle: string) {
    if (!detail) return;
    const sourceId = String(detail.source.id);
    const requestId = deleteRequest.current + 1;
    deleteRequest.current = requestId;
    setDeletePending(true);
    setDeleteError("");
    try {
      const response = await fetch(`/api/reservoir/${encodeURIComponent(sourceId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmTitle }),
      });
      const data = await response.json() as { error?: string; deletedSourceId?: string };
      if (deleteRequest.current !== requestId || selectedIdRef.current !== sourceId) return;
      if (response.status === 404 && data.error === "source_not_found") {
        setItems((current) => current.filter((item) => item.id !== sourceId));
        startInteraction();
        resetSelection();
        setMsg("이미 삭제된 자료라 저장소 목록을 새로 불러왔습니다.");
        await load(filterIntentRef.current);
        return;
      }
      if (!response.ok) throw new Error(data.error ?? "source_delete_failed");
      setItems((current) => current.filter((item) => item.id !== sourceId));
      startInteraction();
      resetSelection();
      setMsg("자료를 영구 삭제했습니다.");
      await load(filterIntentRef.current);
    } catch (error) {
      if (deleteRequest.current !== requestId || selectedIdRef.current !== sourceId) return;
      setDeleteError(sourceDeleteErrorMessage(error instanceof Error ? error.message : "source_delete_failed"));
    } finally {
      if (deleteRequest.current === requestId) setDeletePending(false);
    }
  }

  function retryDecision() {
    if (!decisionRetry) return;
    if (decisionRetry.kind === "signal") void signal(decisionRetry.action);
    else if (decisionRetry.kind === "reanalyze") void reanalyze();
    else void refetch();
  }

  async function runDeepAnalysis() {
    if (!detail || detail.acquisition?.canDeepAnalyze === false) return;
    const sourceId = String(detail.source.id);
    const interactionRequestId = interactionRequest.current;
    const requestId = deepAnalysisRequest.current + 1;
    deepAnalysisRequest.current = requestId;
    const isCurrent = () => interactionRequest.current === interactionRequestId && deepAnalysisRequest.current === requestId;
    let queuedJobId: string | null = null;
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
      queuedJobId = typeof data.job?.id === "string" ? data.job.id : null;
      if (queuedJobId) setDeepJobId(queuedJobId);
      await onJobCreated?.();
      if (!isCurrent()) return;
      setMsg(data.reused ? "이미 진행 중인 심층 정리를 계속합니다." : "심층 정리를 시작했습니다. 완료되면 상단 작업센터에서 결과를 확인할 수 있습니다.");
    } catch (error) {
      if (isCurrent()) setMsg(error instanceof Error && error.message === "monthly_budget_exhausted" ? "이번 달 AI 사용량 한도에 도달했습니다." : error instanceof Error ? error.message : "심층 정리를 시작하지 못했습니다.");
    } finally {
      if (deepAnalysisRequest.current === requestId) setDeepPending(Boolean(queuedJobId));
    }
  }

  useEffect(() => {
    if (!deepJobId) return;
    const job = jobs.find((candidate) => candidate.id === deepJobId && candidate.kind === "DEEP_ANALYSIS");
    if (!job || job.status === "QUEUED" || job.status === "RUNNING") return;
    const sourceId = selectedIdRef.current;
    const input = job.input && typeof job.input === "object" ? job.input as { sourceId?: unknown } : null;
    if (!sourceId || input?.sourceId !== sourceId) {
      setDeepJobId(null);
      return;
    }
    const completionKey = `${job.id}:${job.status}:${job.updatedAt}`;
    if (deepCompletionRef.current === completionKey) return;
    deepCompletionRef.current = completionKey;
    if (job.status !== "SUCCEEDED") {
      setDeepPending(false);
      setDeepJobId(null);
      setMsg(job.error ? `심층 정리를 완료하지 못했습니다: ${job.error}` : "심층 정리를 완료하지 못했습니다. 작업센터에서 다시 시도해 주세요.");
      return;
    }
    void openDetail(sourceId, { preserveAction: true }).then((requestId) => {
      if (selectedIdRef.current !== sourceId || interactionRequest.current !== requestId) return;
      setDeepPending(false);
      setDeepJobId(null);
      setMsg("심층 정리가 완료되었습니다. 최신 결과를 불러왔습니다.");
    });
  }, [deepJobId, jobs]);

  useEffect(() => {
    const sourceId = selectedIdRef.current;
    const versionId = typeof detail?.source.activeVersionId === "string" ? detail.source.activeVersionId : null;
    if (!sourceId || !versionId) return;
    const job = jobs.find((candidate) => {
      if (candidate.kind !== "VISUAL_EXTRACTION" || !["SUCCEEDED", "FAILED", "BLOCKED"].includes(candidate.status)) return false;
      const input = candidate.input && typeof candidate.input === "object"
        ? candidate.input as { sourceId?: unknown; sourceVersionId?: unknown }
        : null;
      return input?.sourceId === sourceId && input?.sourceVersionId === versionId;
    });
    if (!job) return;
    const completionKey = `${job.id}:${job.status}:${job.updatedAt}`;
    if (visualCompletionRef.current === completionKey) return;
    visualCompletionRef.current = completionKey;
    const input = job.input && typeof job.input === "object"
      ? job.input as { extractionRunId?: unknown }
      : null;
    void openDetail(sourceId, {
      preserveAction: true,
      extractionRunId: typeof input?.extractionRunId === "string" ? input.extractionRunId : undefined,
    }).then((requestId) => {
      if (selectedIdRef.current !== sourceId || interactionRequest.current !== requestId) return;
      setMsg(job.status === "SUCCEEDED" ? "시각 자료 분석 결과가 갱신되었습니다." : "시각 자료 분석을 완료하지 못했습니다. 작업센터에서 상태를 확인해 주세요.");
    });
  }, [detail?.source.activeVersionId, jobs]);

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

  async function reviewVisualAnalysis(assetId: string, action: "accept" | "dismiss") {
    try {
      const response = await fetch(`/api/visual-assets/${assetId}/analysis`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error("visual_review_failed");
      const data = await response.json() as { asset?: VisualAssetSummary | null };
      if (data.asset) {
        setUnassignedVisuals((current) => current.map((asset) => asset.id === data.asset?.id ? data.asset : asset));
        setDetail((current) => current ? { ...current, visuals: current.visuals?.map((asset) => asset.id === data.asset?.id ? data.asset! : asset) } : current);
      }
      setMsg(action === "accept" ? "시각 제안을 채택했습니다." : "시각 제안을 보류했습니다.");
    } catch {
      setMsg("시각 제안의 검토 상태를 저장하지 못했습니다.");
    }
  }

  function syncVisualAsset(nextAsset: VisualAssetSummary) {
    setUnassignedVisuals((current) => (
      nextAsset.parentSourceId
        ? current.filter((asset) => asset.id !== nextAsset.id)
        : current.map((asset) => asset.id === nextAsset.id ? nextAsset : asset)
    ));
    setDetail((current) => {
      if (!current) return current;
      const currentSourceId = String(current.source.id);
      const visuals = current.visuals ?? [];
      if (nextAsset.parentSourceId === currentSourceId) {
        const exists = visuals.some((asset) => asset.id === nextAsset.id);
        return {
          ...current,
          visuals: exists
            ? visuals.map((asset) => asset.id === nextAsset.id ? nextAsset : asset)
            : [...visuals, nextAsset],
        };
      }
      return { ...current, visuals: visuals.filter((asset) => asset.id !== nextAsset.id) };
    });
  }

  async function startPdfExtraction() {
    if (!detail) return;
    const capability = detail.visualExtractionCapability;
    if (!capability?.canStart || !capability.originalUrl) {
      setMsg("텍스트만 보존된 PDF입니다. 원본 PDF를 다시 첨부해 주세요.");
      return;
    }
    const sourceId = String(detail.source.id);
    const versionId = typeof detail.source.activeVersionId === "string" ? detail.source.activeVersionId : "";
    if (!versionId) return;
    const requestId = interactionRequest.current;
    setPdfExtractionPending(true);
    setMsg("PDF 페이지를 준비하고 있습니다. 다른 페이지로 이동해도 계속됩니다.");
    const task = startPdfVisualExtractionTask({
      sourceId,
      sourceVersionId: versionId,
      originalUrl: capability.originalUrl,
      title: formatSourceTitle(String(detail.source.title ?? "현재 자료")),
    });
    try {
      const result = await task.promise;
      if (!result) return;
      if (interactionRequest.current !== requestId) return;
      setPdfExtraction(result);
      setMsg(result.remainingPages > 0 ? "남은 PDF 페이지를 이어서 업로드할 수 있습니다." : "PDF 페이지 업로드를 마쳤습니다.");
      if (result.status === "QUEUED" || result.status === "RUNNING") await onJobCreated?.();
    } catch (error) {
      if (interactionRequest.current !== requestId) return;
      setMsg(error instanceof Error ? error.message : "PDF 시각 자료 추출을 시작하지 못했습니다.");
    } finally {
      if (interactionRequest.current === requestId) setPdfExtractionPending(false);
    }
  }

  async function stopPdfExtraction() {
    if (!detail?.source.activeVersionId) return;
    stopPdfVisualExtractionTask(String(detail.source.id), String(detail.source.activeVersionId));
    setPdfExtractionPending(false);
    setMsg("PDF 페이지 준비를 일시 중지했습니다. 같은 자료에서 이어서 시작할 수 있습니다.");
  }

  function closePdfSheet() {
    setPdfSheetOpen(false);
    pdfSheetTriggerRef.current?.focus();
  }

  const indexItems = useMemo(() => searchHits
    ? searchHits.map((hit) => ({ id: hit.sourceId, title: hit.title, meta: hit.matched, tags: hit.snippet ? [hit.snippet] : [], access: deriveSourceAccess({ href: null }) }))
    : items.map(toIndexItem), [items, searchHits]);
  const visualSourceOptions = useMemo(() => {
    const mapped = items.map((item) => ({
      id: item.id,
      title: formatSourceTitle(item.titleKo?.trim() || item.title),
      sourceVersionId: item.activeVersionId ?? null,
      meta: [KIND_LABELS[item.kind] ?? item.kind, item.year].filter(Boolean).join(" · "),
    }));
    if (detail) {
      const currentSourceId = String(detail.source.id);
      const currentTitle = formatSourceTitle(String(detail.source.title ?? "현재 자료"));
      const currentMeta = [KIND_LABELS[String(detail.source.kind ?? "")] ?? String(detail.source.kind ?? ""), detail.source.year].filter(Boolean).join(" · ");
      const currentVersionId = typeof detail.source.activeVersionId === "string" && detail.source.activeVersionId.trim()
        ? detail.source.activeVersionId
        : null;
      return [{ id: currentSourceId, title: currentTitle, sourceVersionId: currentVersionId, meta: currentMeta }, ...mapped.filter((option) => option.id !== currentSourceId)];
    }
    return mapped;
  }, [detail, items]);
  const document = detail ? toReadingDocument(detail) : null;
  const acquisitionDeepBlocked = detail?.acquisition?.canDeepAnalyze === false;
  const reviewBlocked = detail?.acquisition?.textScope === "FULLTEXT" && detail.acquisition.qualityStatus === "REVIEW";
  const canonicalUrl = typeof detail?.source.canonicalUrl === "string" && detail.source.canonicalUrl.trim()
    ? detail.source.canonicalUrl
    : null;
  const deepBlockReason = acquisitionDeepBlocked && detail?.acquisition
    ? acquisitionBlockReason(detail.acquisition, Boolean(canonicalUrl), detail.source.inputFormat)
    : deepBlock
      ? deepAnalysisBlockReason(deepBlock)
      : null;
  const isPdfSource = detail?.source.inputFormat === "PDF_TEXT" || detail?.source.inputFormat === "PDF_SCAN";
  const hasPdfActiveVersion = typeof detail?.source.activeVersionId === "string" && detail.source.activeVersionId.trim().length > 0;
  const pdfCapability = detail?.visualExtractionCapability;
  const canExtractPdf = isPdfSource && hasPdfActiveVersion && pdfCapability?.canStart === true;
  const needsPdfOriginal = isPdfSource && hasPdfActiveVersion
    && (pdfCapability?.state === "ORIGINAL_MISSING" || pdfCapability?.state === "ORIGINAL_OBJECT_MISSING");
  const deepDisabled = acquisitionDeepBlocked || Boolean(deepBlock);
  const deepActionLabel = reviewBlocked
    ? "품질 다시 검사"
    : deepDisabled
      ? canonicalUrl ? "원문 다시 가져오기" : "본문 보강 필요"
      : "심층 정리하기";
  const visualExtractionStatus = detail
    ? {
      sourceKind: isPdfSource ? "PDF" as const : "WEB" as const,
      run: detail.visualExtractionRun ?? null,
      acquisition: detail.acquisition ?? null,
    }
    : null;
  const pdfSheetVisible = compactViewport && pdfSheetOpen && canExtractPdf;
  const { handleKeyDown: handlePdfSheetKeyDown } = useModalAccessibility({
    open: pdfSheetVisible,
    dialogRef: pdfSheetDialogRef,
    layerRef: pdfSheetLayerRef,
    onClose: closePdfSheet,
    getInitialFocusTarget: () => pdfSheetCloseRef.current,
    initialFocusDeps: [selectedId, pdfSheetOpen, pdfExtraction?.runId, pdfExtraction?.remainingPages],
  });
  const pdfProgressPanel = (
    <PdfExtractionProgress
      state={pdfExtraction}
      busy={pdfExtractionPending}
      onStart={startPdfExtraction}
      onContinue={startPdfExtraction}
      onStop={stopPdfExtraction}
    />
  );

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
      <VisualAssetPanel
        assets={unassignedVisuals}
        title="연결되지 않은 시각 자료"
        mode="unassigned"
        sourceOptions={visualSourceOptions}
        onAnalysisAction={reviewVisualAnalysis}
        onAssetUpdated={syncVisualAsset}
      />
      {msg && <p className="reservoir-message" role="status">{msg}</p>}
      {decisionError && <StatusMessage kind="error" title={decisionError} action={decisionRetry ? <button className="ui-button-secondary" onClick={retryDecision}>다시 시도</button> : undefined} />}
      {listError ? <StatusMessage kind="error" title={listError} action={<button className="ui-button-secondary" onClick={() => void load()}>다시 시도</button>} /> : <SplitWorkspace
        readingKey={selectedId}
        mobilePane={selectedId ? "reading" : "index"}
        index={<SourceIndex title="저장소 자료" items={indexItems} selectedId={selectedId} onSelect={(id) => void openDetail(id)} />}
      reading={detailError ? <><ReadingActionBar message="상세 내용을 불러오지 못했습니다." onBack={clearSelection} /><StatusMessage kind="error" title={detailError} action={<button className="ui-button-secondary" onClick={() => selectedId && void openDetail(selectedId)}>다시 시도</button>} /></> : detailLoading ? <><ReadingActionBar message="자료 상세 내용을 불러오는 중…" onBack={clearSelection} /><StatusMessage kind="loading" title="자료 상세 내용을 불러오는 중…" description="원문과 분석 내용을 준비하고 있습니다." /></> : document ? <><ReadingActionBar statusLabel={detail?.source.decisionStatus ? DECISION_STATUS_LABELS[detail.source.decisionStatus as DecisionAction["id"]] : null} pending={actionPending} onBack={clearSelection} onOpenDecision={() => setDecisionOpen(true)} /><div className="deep-analysis-controls" aria-label="심층 정리 실행"><label htmlFor="deep-analysis-profile">심층 정리 품질</label><select id="deep-analysis-profile" value={deepProfile} onChange={(event) => setDeepProfile(event.target.value as "precision" | "maximum")} disabled={deepPending || deepDisabled}><option value="precision">정밀 · 긴 본문 구조화</option><option value="maximum">최고 정밀 · 논거와 연결 검토</option></select><button type="button" className="ui-button" onClick={() => reviewBlocked ? void reanalyze() : deepDisabled ? void refetch() : void runDeepAnalysis()} disabled={deepPending || actionPending || (deepDisabled && !reviewBlocked && !canonicalUrl)}>{actionPending ? (reviewBlocked ? "품질 다시 검사 중…" : "원문 수집 중…") : deepPending ? "심층 정리 중…" : deepActionLabel}</button></div>{canExtractPdf && !compactViewport && pdfProgressPanel}{canExtractPdf && compactViewport && <div className="deep-analysis-controls"><button ref={pdfSheetTriggerRef} type="button" className="ui-button" onClick={() => setPdfSheetOpen(true)}>{pdfExtraction && pdfExtraction.remainingPages > 0 ? "계속" : "시각 자료 찾기"}</button></div>}{needsPdfOriginal && <PdfOriginalRecovery sourceId={String(detail.source.id)} onRecovered={() => openDetail(String(detail.source.id), { preserveAction: true })} />}{deepBlockReason && <p className="deep-analysis-blocked" role="status">{deepBlockReason}</p>}<ReadingPane document={document} deepAnalysis={detail?.deepAnalysis} deepAnalysisHistory={detail?.deepAnalysisHistory} onOpenDeepHistory={(id) => void openDeepHistory(id)} supplementary={visualExtractionStatus ? <VisualAssetPanel assets={[]} extractionContext={visualExtractionStatus} onRequestAcquisition={canonicalUrl && !reviewBlocked ? refetch : undefined} acquisitionPending={actionPending} title="시각 자료 상태" /> : undefined} />{detail?.visuals && <VisualAssetPanel assets={detail.visuals} extractionContext={visualExtractionStatus} showExtractionStatus={false} onAnalysisAction={reviewVisualAnalysis} onAssetUpdated={syncVisualAsset} />}<section className="source-delete-zone" aria-labelledby="source-delete-zone-title"><div><h3 id="source-delete-zone-title">위험 영역</h3><p>이 자료의 원본, 분석, 버전과 연결된 시각 자료를 영구 삭제합니다.</p></div><button type="button" className="ui-button-danger-outline" disabled={actionPending || deepPending || pdfExtractionPending} onClick={() => { setDeleteError(""); setDeleteOpen(true); }}>자료 삭제</button></section></> : <StatusMessage kind="empty" title="읽을 자료를 선택하세요" description="왼쪽 목록에서 자료를 고르면 원문과 분석 내용을 함께 읽을 수 있습니다." />}
      />}
      {pdfSheetVisible && globalThis.document.body && createPortal(
        <div ref={pdfSheetLayerRef} className="decision-sheet-layer">
          <button type="button" className="decision-sheet__scrim" aria-label="PDF 시각 자료 추출 닫기" onClick={closePdfSheet} />
          <section
            ref={pdfSheetDialogRef}
            className="decision-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="PDF 시각 자료 추출"
            tabIndex={-1}
            onKeyDown={handlePdfSheetKeyDown}
          >
            <div className="decision-sheet__handle" aria-hidden="true" />
            <button ref={pdfSheetCloseRef} type="button" className="decision-sheet__close" aria-label="닫기" onClick={closePdfSheet}>×</button>
            {pdfProgressPanel}
          </section>
        </div>,
        globalThis.document.body,
      )}
      {document && <DecisionBottomSheet document={document} decisionStatus={detail?.source.decisionStatus as DecisionAction["id"] | null} open={decisionOpen} pending={actionPending} pendingAction={pendingAction} error={decisionError} onClose={() => setDecisionOpen(false)} onAction={(action) => void signal(action)} secondaryAction={{ label: "다시 분석하기", onClick: reanalyze }}><div className="source-detail-extra"><div className="source-detail-extra__heading"><h3>자료 기록</h3><button className="ui-button-secondary" type="button" disabled={actionPending || !canonicalUrl} onClick={() => void refetch()}>다시 가져오기</button></div><p>{detail?.versions.length ?? 0}개 버전 · {detail?.signals.length ?? 0}개 판단 기록</p>{!canonicalUrl && <p>원문 주소가 없어 다시 가져올 수 없습니다.</p>}</div></DecisionBottomSheet>}
      {detail && <SourceDeleteDialog open={deleteOpen} sourceId={detail.deletion.sourceId} title={detail.deletion.title} mergeRole={detail.deletion.mergeRole} mergeMemberCount={detail.deletion.mergeMemberCount} pending={deletePending} error={deleteError} onClose={() => { if (!deletePending) { setDeleteOpen(false); setDeleteError(""); } }} onConfirm={deleteCurrentSource} />}
      {searchHits && <p className="table-note">검색 결과 {searchHits.length}개 · 검색 결과를 선택하면 같은 읽기 화면에서 확인합니다.</p>}
      {detail && <p className="table-note">마지막 확인: {formatDateKo(String(detail.source.createdAt ?? ""))}</p>}
    </div>
  );
}
