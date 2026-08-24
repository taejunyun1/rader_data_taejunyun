import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiscoveryKeepResponse, DiscoveryKeywordRecommendation, DiscoveryProfile, DiscoverySourcePreset, ResearchJob, View } from "@radar/shared";
import { DISCOVERY_SOURCE_PRESETS } from "@radar/shared";
import type { DiscoveryRunDiagnostics } from "@radar/shared/discoveryRun";
import type {
  DiscoveryFieldSignal,
  DiscoveryFieldSignalRunDiagnostics,
  DiscoveryFieldSignalStatus,
  DiscoveryFieldSignalType,
} from "@radar/shared/fieldSignals";
import DiscoveryDirectionPanel from "../components/discovery/DiscoveryDirectionPanel";
import DiscoveryRunSummary from "../components/discovery/DiscoveryRunSummary";
import FieldSignalList from "../components/discovery/FieldSignalList";
import FieldSignalRunSummary from "../components/discovery/FieldSignalRunSummary";
import PageHeader from "../components/layout/PageHeader";
import DecisionBottomSheet, { DECISION_STATUS_LABELS } from "../components/reading/DecisionBottomSheet";
import ReadingActionBar from "../components/reading/ReadingActionBar";
import ReadingPane from "../components/reading/ReadingPane";
import SourceIndex from "../components/reading/SourceIndex";
import SplitWorkspace from "../components/reading/SplitWorkspace";
import type { DecisionAction, ReadingDocument, SourceIndexItem } from "../components/reading/types";
import StatusMessage from "../components/ui/StatusMessage";
import { labelOf, PROVIDER_LABELS } from "../lib/labels";
import { deriveSourceAccess } from "../lib/sourceAccess";
import { formatSourceTitle } from "../lib/sourcePresentation";

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
  sourceId?: string | null;
}

interface HomepageProject {
  slug: string;
  title: string;
  year: number | null;
  projectUrl: string;
  imageCount: number;
  videoCount: number;
}

interface CandidateIntent {
  candidateId: string | null;
  generation: number;
}

interface CandidateListRequest {
  generation: number;
  controller: AbortController;
}

interface FieldSignalFilterIntent {
  status: DiscoveryFieldSignalStatus;
  type: "" | DiscoveryFieldSignalType;
  generation: number;
}

interface FieldSignalListRequest {
  generation: number;
  controller: AbortController;
}

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

const FIELD_SIGNAL_STATUS_FILTERS: Array<{ value: DiscoveryFieldSignalStatus; label: string }> = [
  { value: "NEW", label: "새 신호" },
  { value: "SAVED", label: "저장됨" },
  { value: "DISMISSED", label: "제외됨" },
];

const FIELD_SIGNAL_TYPE_FILTERS: Array<{ value: "" | DiscoveryFieldSignalType; label: string }> = [
  { value: "", label: "전체 유형" },
  { value: "CONFERENCE", label: "학회·심포지엄" },
  { value: "CALL_FOR_PAPERS", label: "CFP" },
  { value: "EXHIBITION", label: "전시" },
  { value: "GRANT", label: "지원·펠로십" },
  { value: "RESIDENCY", label: "레지던시" },
  { value: "WORKSHOP", label: "워크숍" },
  { value: "INSTITUTION_NEWS", label: "기관 소식" },
  { value: "OTHER", label: "기타" },
];

function sourceCollectionLabel(source: DiscoverySourcePreset): string {
  if (source.autoCollect && source.target === "READING") return "읽을거리 자동 수집";
  if (source.autoCollect && source.target === "FIELD_SIGNAL") return "현장 신호 자동 수집";
  if (source.collection === "RSS") return "공식 RSS · 자동 수집 안 함";
  if (source.collection === "API") return "공식 API 연결 필요";
  return "검색 링크로 확인";
}

const DISCOVERY_ACTIONS: DecisionAction[] = [
  { id: "develop", label: "발전시키기", description: "저장소에 보관하고 연구 방향에 반영" },
  { id: "keep", label: "보관하기", description: "다음 리서치까지 표시해 두기" },
  { id: "watch", label: "관찰하기", description: "관련 흐름이 생길 때 다시 보기" },
  { id: "ignore", label: "제외하기", description: "추천 우선순위만 낮추기" },
];

function candidateAccess(candidate: Candidate) {
  return deriveSourceAccess({
    provider: candidate.provider,
    href: candidate.externalUrl ?? candidate.openalexId,
    accessStatus: candidate.accessStatus ?? undefined,
  });
}

function toIndexItem(candidate: Candidate): SourceIndexItem {
  return {
    id: candidate.id,
    title: formatSourceTitle(candidate.titleKo?.trim() || candidate.title),
    meta: [
      candidate.discoveryLane === "COUNTER" ? "카운터" : "오리지널",
      "후보",
      labelOf(PROVIDER_LABELS, candidate.provider),
      candidate.year,
      candidate.relevanceScore == null ? null : `관련도 ${candidate.relevanceScore.toFixed(2)}`,
    ].filter(Boolean).join(" · "),
    tags: [candidate.queryUsed, candidate.querySource].filter(Boolean).map(String),
    access: candidateAccess(candidate),
  };
}

function toReadingDocument(candidate: Candidate): ReadingDocument {
  return {
    id: candidate.id,
    title: formatSourceTitle(candidate.titleKo?.trim() || candidate.title),
    originalTitle: candidate.originalTitle?.trim()
      ? formatSourceTitle(candidate.originalTitle)
      : candidate.titleKo?.trim()
        ? formatSourceTitle(candidate.title)
        : undefined,
    byline: [candidate.authors, candidate.year, labelOf(PROVIDER_LABELS, candidate.provider)].filter(Boolean).map(String).join(" · "),
    provenance: `발견 후보 · ${candidate.discoveryLane === "COUNTER" ? "카운터 방향" : "오리지널 방향"} · ${candidate.queryUsed ? `검색어 ${candidate.queryUsed}` : "검색어 정보 없음"}`,
    access: candidateAccess(candidate),
    summary: null,
    fragments: [],
    questions: [candidate.queryUsed ? `${candidate.queryUsed}와 이 자료는 어떤 관계를 갖는가?` : "이 자료가 지금의 작업과 어떤 관계를 갖는가?"],
    keywords: [],
  };
}

function candidateDecisionStatus(candidate: Candidate | null): DecisionAction["id"] | null {
  if (!candidate) return null;
  if (candidate.status === "KEPT") return "keep";
  if (candidate.status === "WATCHED") return "watch";
  if (candidate.status === "IGNORED") return "ignore";
  if (candidate.status === "DEVELOPED") return "develop";
  return null;
}

export default function DiscoverView({
  onNavigate,
  onOpenReservoir,
  jobs = [],
  onJobCreated,
}: {
  onNavigate: (view: View) => void;
  onOpenReservoir?: (sourceId: string) => void;
  jobs?: ResearchJob[];
  onJobCreated?: () => Promise<void>;
}) {
  const [contentMode, setContentMode] = useState<"READING" | "FIELD_SIGNAL">("READING");
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
  const [profile, setProfile] = useState<DiscoveryProfile>({
    original: { keywords: [], strength: 70 },
    counter: { keywords: [], strength: 30 },
    updatedAt: "",
  });
  const [profileDraft, setProfileDraft] = useState(profile);
  const [recommendations, setRecommendations] = useState<{ original: DiscoveryKeywordRecommendation[]; counter: DiscoveryKeywordRecommendation[] }>({
    original: [],
    counter: [],
  });
  const [profileDirty, setProfileDirty] = useState(false);
  const [feeds, setFeeds] = useState("");
  const [feedMsg, setFeedMsg] = useState("");
  const [homepageProjects, setHomepageProjects] = useState<HomepageProject[]>([]);
  const [homepageExtractedAt, setHomepageExtractedAt] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<DiscoveryRunDiagnostics | null>(null);
  const [runCollected, setRunCollected] = useState(0);
  const [fieldSignals, setFieldSignals] = useState<DiscoveryFieldSignal[]>([]);
  const [fieldSignalStatus, setFieldSignalStatus] = useState<DiscoveryFieldSignalStatus>("NEW");
  const [fieldSignalType, setFieldSignalType] = useState<"" | DiscoveryFieldSignalType>("");
  const [fieldSignalError, setFieldSignalError] = useState("");
  const [pendingFieldSignalId, setPendingFieldSignalId] = useState<string | null>(null);
  const [fieldSignalRunSummary, setFieldSignalRunSummary] = useState<DiscoveryFieldSignalRunDiagnostics | null>(null);
  const [fieldSignalsCollected, setFieldSignalsCollected] = useState(0);
  const [keptAcquisitionIntent, setKeptAcquisitionIntent] = useState<CandidateIntent & { jobId: string } | null>(null);
  const candidateIntentRef = useRef<CandidateIntent>({ candidateId: null, generation: 0 });
  const candidateListRequestRef = useRef<CandidateListRequest | null>(null);
  const keptAcquisitionIntentRef = useRef<CandidateIntent & { jobId: string } | null>(null);
  const canAutoSelectCandidateRef = useRef(true);
  const fieldSignalFilterIntentRef = useRef<FieldSignalFilterIntent>({ status: "NEW", type: "", generation: 0 });
  const fieldSignalListRequestRef = useRef<FieldSignalListRequest | null>(null);
  const fieldSignalActionRequestRef = useRef(0);

  const replaceKeptAcquisitionIntent = useCallback((intent: CandidateIntent & { jobId: string } | null) => {
    keptAcquisitionIntentRef.current = intent;
    setKeptAcquisitionIntent(intent);
  }, []);

  const advanceCandidateIntent = useCallback((candidateId: string | null): CandidateIntent => {
    const next = { candidateId, generation: candidateIntentRef.current.generation + 1 };
    candidateIntentRef.current = next;
    return next;
  }, []);

  const isCurrentCandidateIntent = useCallback((intent: CandidateIntent): boolean => (
    candidateIntentRef.current.candidateId === intent.candidateId
    && candidateIntentRef.current.generation === intent.generation
  ), []);

  const beginCandidateListRequest = useCallback((): CandidateListRequest => {
    candidateListRequestRef.current?.controller.abort();
    const request = {
      generation: (candidateListRequestRef.current?.generation ?? 0) + 1,
      controller: new AbortController(),
    };
    candidateListRequestRef.current = request;
    return request;
  }, []);

  const isCurrentCandidateListRequest = useCallback((request: CandidateListRequest): boolean => (
    candidateListRequestRef.current?.generation === request.generation
  ), []);

  const isCurrentFieldSignalFilterIntent = useCallback((intent: FieldSignalFilterIntent): boolean => (
    fieldSignalFilterIntentRef.current.status === intent.status
    && fieldSignalFilterIntentRef.current.type === intent.type
    && fieldSignalFilterIntentRef.current.generation === intent.generation
  ), []);

  const updateFieldSignalFilter = useCallback((status: DiscoveryFieldSignalStatus, type: "" | DiscoveryFieldSignalType) => {
    const current = fieldSignalFilterIntentRef.current;
    if (current.status === status && current.type === type) return current;
    const next = { status, type, generation: current.generation + 1 };
    fieldSignalFilterIntentRef.current = next;
    fieldSignalListRequestRef.current?.controller.abort();
    fieldSignalActionRequestRef.current += 1;
    setPendingFieldSignalId(null);
    setFieldSignalStatus(status);
    setFieldSignalType(type);
    return next;
  }, []);

  const beginFieldSignalListRequest = useCallback((): FieldSignalListRequest => {
    fieldSignalListRequestRef.current?.controller.abort();
    const request = {
      generation: (fieldSignalListRequestRef.current?.generation ?? 0) + 1,
      controller: new AbortController(),
    };
    fieldSignalListRequestRef.current = request;
    return request;
  }, []);

  const isCurrentFieldSignalListRequest = useCallback((request: FieldSignalListRequest): boolean => (
    fieldSignalListRequestRef.current?.generation === request.generation
  ), []);

  const openReservoir = useCallback((sourceId: string) => {
    if (onOpenReservoir) {
      onOpenReservoir(sourceId);
      return;
    }
    onNavigate("RESERVOIR");
  }, [onNavigate, onOpenReservoir]);

  const clearCandidateSelection = useCallback(({ preserveKeptAcquisitionIntent = false }: { preserveKeptAcquisitionIntent?: boolean } = {}) => {
    canAutoSelectCandidateRef.current = false;
    if (!preserveKeptAcquisitionIntent) {
      advanceCandidateIntent(null);
      replaceKeptAcquisitionIntent(null);
    }
    setSelectedId(null);
    setDecisionOpen(false);
    setDecisionError("");
    setBusy(false);
    setPendingAction(null);
  }, [advanceCandidateIntent, replaceKeptAcquisitionIntent]);

  const load = useCallback(async (intent?: CandidateIntent) => {
    if (intent && !isCurrentCandidateIntent(intent)) return;
    const requestIntent = intent ?? candidateIntentRef.current;
    const request = beginCandidateListRequest();
    setListError("");
    try {
      const response = await fetch(`/api/discover/candidates?status=${statusFilter}${laneFilter ? `&lane=${laneFilter}` : ""}`, {
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error("candidates_failed");
      const data = await response.json() as { items?: Candidate[] };
      if (!isCurrentCandidateListRequest(request) || !isCurrentCandidateIntent(requestIntent)) return;
      const next = data.items ?? [];
      setCandidates(next);
      const selectedCandidateId = candidateIntentRef.current.candidateId;
      if (selectedCandidateId && !next.some((candidate) => candidate.id === selectedCandidateId)) {
        const pendingKeep = keptAcquisitionIntentRef.current;
        const isExpectedKeepDisappearance = pendingKeep?.candidateId === selectedCandidateId
          && isCurrentCandidateIntent(pendingKeep);
        clearCandidateSelection({ preserveKeptAcquisitionIntent: isExpectedKeepDisappearance });
        return;
      }
      if (canAutoSelectCandidateRef.current && !selectedCandidateId && next[0]) {
        canAutoSelectCandidateRef.current = false;
        advanceCandidateIntent(next[0].id);
        setSelectedId(next[0].id);
      }
    } catch (error) {
      if (!isCurrentCandidateListRequest(request) || !isCurrentCandidateIntent(requestIntent)) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setListError("발견 후보를 불러오지 못했습니다.");
    }
  }, [beginCandidateListRequest, clearCandidateSelection, isCurrentCandidateIntent, isCurrentCandidateListRequest, laneFilter, statusFilter]);

  const loadFieldSignals = useCallback(async (intent: FieldSignalFilterIntent = fieldSignalFilterIntentRef.current) => {
    if (!isCurrentFieldSignalFilterIntent(intent)) return;
    const request = beginFieldSignalListRequest();
    setFieldSignalError("");
    try {
      const response = await fetch(`/api/discover/signals?status=${intent.status}${intent.type ? `&type=${intent.type}` : ""}`, {
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error("field_signals_failed");
      const data = await response.json() as { items?: DiscoveryFieldSignal[] };
      if (!isCurrentFieldSignalListRequest(request) || !isCurrentFieldSignalFilterIntent(intent)) return;
      setFieldSignals(data.items ?? []);
    } catch (error) {
      if (!isCurrentFieldSignalListRequest(request) || !isCurrentFieldSignalFilterIntent(intent)) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setFieldSignalError("현장 신호를 불러오지 못했습니다.");
    }
  }, [beginFieldSignalListRequest, isCurrentFieldSignalFilterIntent, isCurrentFieldSignalListRequest]);

  useEffect(() => {
    void load();
    return () => candidateListRequestRef.current?.controller.abort();
  }, [load]);

  useEffect(() => {
    if (contentMode === "FIELD_SIGNAL") {
      void loadFieldSignals();
    }
    return () => fieldSignalListRequestRef.current?.controller.abort();
  }, [contentMode, fieldSignalStatus, fieldSignalType, loadFieldSignals]);

  useEffect(() => {
    if (!keptAcquisitionIntent) return;
    const keptAcquisition = jobs.find((job) => job.id === keptAcquisitionIntent.jobId && job.kind === "SOURCE_ACQUISITION");
    const resultRef = keptAcquisition?.resultRef;
    if (keptAcquisition?.status === "SUCCEEDED" && resultRef?.view === "RESERVOIR" && "acquisition" in resultRef && resultRef.acquisition) {
      if (!isCurrentCandidateIntent(keptAcquisitionIntent)) return;
      replaceKeptAcquisitionIntent(null);
      setMsg("원문 수집이 완료되었습니다. 저장소에서 확인하세요.");
      openReservoir(resultRef.sourceId);
    }
  }, [isCurrentCandidateIntent, jobs, keptAcquisitionIntent, openReservoir, replaceKeptAcquisitionIntent]);

  useEffect(() => {
    const latest = jobs.find((job) => job.kind === "DISCOVERY_RUN");
    if (!latest) return;

    if (latest.status === "SUCCEEDED") {
      const result = latest.result && typeof latest.result === "object"
        ? latest.result as {
            collected?: unknown;
            fieldSignalsCollected?: unknown;
            diagnostics?: DiscoveryRunDiagnostics;
            fieldSignalDiagnostics?: DiscoveryFieldSignalRunDiagnostics;
          }
        : {};
      const readingCount = Number(result.collected ?? 0);
      const signalCount = Number(result.fieldSignalsCollected ?? 0);
      setMsg(`발견 수집 완료 · 새 읽을거리 ${readingCount}개 · 현장 신호 ${signalCount}개`);
      setRunCollected(readingCount);
      setFieldSignalsCollected(signalCount);
      setRunSummary(result.diagnostics ?? null);
      setFieldSignalRunSummary(result.fieldSignalDiagnostics ?? null);
      void load();
      void loadFieldSignals();
      return;
    }

    if (latest.status === "FAILED" || latest.status === "BLOCKED") {
      setMsg(latest.error ?? "발견 수집에 실패했습니다.");
      setRunSummary(null);
      setFieldSignalRunSummary(null);
    }
  }, [jobs, load, loadFieldSignals]);

  useEffect(() => {
    fetch("/api/discover/profile").then((r) => r.json() as Promise<{ profile?: DiscoveryProfile }>).then((data) => {
      if (data.profile) {
        setProfile(data.profile);
        setProfileDraft(data.profile);
      }
    }).catch(() => undefined);
    fetch("/api/discover/recommendations").then((r) => r.json() as Promise<{ recommendations?: { original?: DiscoveryKeywordRecommendation[]; counter?: DiscoveryKeywordRecommendation[] } }>).then((data) => {
      setRecommendations({
        original: data.recommendations?.original ?? [],
        counter: data.recommendations?.counter ?? [],
      });
    }).catch(() => undefined);
    fetch("/api/discover/feeds").then((r) => r.json() as Promise<{ feeds: string[] }>).then((data) => setFeeds((data.feeds ?? []).join("\n"))).catch(() => undefined);
    fetch("/api/settings/homepage").then((r) => r.json() as Promise<{ extractedAt?: string; projects?: HomepageProject[] }>).then((data) => {
      setHomepageProjects(data.projects ?? []);
      setHomepageExtractedAt(data.extractedAt ?? null);
    }).catch(() => undefined);
  }, []);

  async function runDiscovery() {
    setBusy(true);
    setRunSummary(null);
    setFieldSignalRunSummary(null);
    try {
      const response = await fetch("/api/discover/run", { method: "POST" });
      const data = await response.json() as { job?: unknown; reused?: boolean; error?: string };
      if (!response.ok) throw new Error(data.error ?? "발견 실행을 시작하지 못했습니다.");
      await onJobCreated?.();
      setMsg(data.reused ? "이미 진행 중인 발견 수집을 계속합니다." : "발견 수집을 시작했습니다. 완료되면 상단 작업센터에서 후보를 확인할 수 있습니다.");
      setStatusFilter("CANDIDATE");
      updateFieldSignalFilter("NEW", fieldSignalFilterIntentRef.current.type);
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "발견 실행을 시작하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  function handleSummaryAction(action: "RETRY" | "EDIT_QUERY" | "OPEN_STATUS") {
    if (action === "RETRY") {
      void runDiscovery();
      return;
    }
    if (action === "OPEN_STATUS") {
      setStatusFilter("KEPT");
      setContentMode("READING");
      setMsg("보관됨 후보를 표시했습니다.");
      return;
    }
    globalThis.document.querySelector<HTMLElement>(".discovery-settings")?.setAttribute("open", "");
    setMsg("검색 설정에서 짧은 개념어를 확인하세요.");
  }

  async function act(id: string, action: DecisionAction["id"]) {
    const intent = candidateIntentRef.current;
    if (intent.candidateId !== id) return;
    setBusy(true);
    setPendingAction(action);
    setDecisionError("");
    try {
      const backendAction = action === "develop" || action === "keep" ? "keep" : action;
      const response = await fetch(`/api/discover/candidates/${id}/${backendAction}`, { method: "POST" });
      const data = await response.json() as Partial<DiscoveryKeepResponse> & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "분류 저장에 실패했습니다.");
      if (!isCurrentCandidateIntent(intent)) return;
      if (data.jobId) {
        replaceKeptAcquisitionIntent({ ...intent, jobId: data.jobId });
        await onJobCreated?.();
        if (!isCurrentCandidateIntent(intent)) return;
      }
      if (action === "develop" && data.sourceId) {
        await fetch("/api/signals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceId: data.sourceId, action: "develop" }),
        });
        if (!isCurrentCandidateIntent(intent)) return;
        setMsg("발전시키기로 기록했습니다. 저장소에서 이어 읽습니다.");
        setDecisionOpen(false);
        openReservoir(data.sourceId);
      } else {
        setMsg(action === "keep"
          ? data.acquisitionStatus === "LINK_ONLY"
            ? "링크만 저장했습니다. 원문 주소를 확인해 주세요."
            : data.jobId
              ? "원문 수집을 시작했습니다. 작업센터에서 진행 상태를 확인하세요."
              : "보관하기로 기록했습니다."
          : `${action === "watch" ? "관찰하기" : "제외하기"}로 기록했습니다.`);
        setDecisionOpen(false);
      }
      await load(intent);
    } catch (error) {
      if (!isCurrentCandidateIntent(intent)) return;
      setDecisionError(error instanceof Error ? error.message : "분류를 저장하지 못했습니다.");
    } finally {
      if (isCurrentCandidateIntent(intent)) {
        setBusy(false);
        setPendingAction(null);
      }
    }
  }

  async function actOnFieldSignal(id: string, action: "save" | "dismiss" | "restore") {
    const filterIntent = fieldSignalFilterIntentRef.current;
    const requestId = fieldSignalActionRequestRef.current + 1;
    fieldSignalActionRequestRef.current = requestId;
    const isCurrent = () => (
      fieldSignalActionRequestRef.current === requestId
      && isCurrentFieldSignalFilterIntent(filterIntent)
    );
    setPendingFieldSignalId(id);
    try {
      const response = await fetch(`/api/discover/signals/${id}/${action}`, { method: "POST" });
      if (!response.ok) throw new Error("field_signal_action_failed");
      if (!isCurrent()) return;
      setMsg(action === "save" ? "현장 신호를 저장했습니다." : action === "dismiss" ? "현장 신호를 제외했습니다." : "현장 신호를 복구했습니다.");
      await loadFieldSignals(filterIntent);
    } catch {
      if (isCurrent()) setMsg("현장 신호 상태를 저장하지 못했습니다.");
    } finally {
      if (fieldSignalActionRequestRef.current === requestId) setPendingFieldSignalId(null);
    }
  }

  function selectCandidate(id: string) {
    const candidate = candidates.find((item) => item.id === id);
    canAutoSelectCandidateRef.current = false;
    advanceCandidateIntent(id);
    setSelectedId(id);
    setDecisionError("");
    setDecisionOpen(false);
    setBusy(false);
    setPendingAction(null);
    replaceKeptAcquisitionIntent(null);
    if (candidate?.status === "KEPT" && candidate.sourceId) {
      openReservoir(candidate.sourceId);
    }
  }

  async function saveProfile() {
    const response = await fetch("/api/discover/profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: profileDraft }) });
    if (!response.ok) {
      setMsg("검색 설정을 저장하지 못했습니다.");
      return;
    }
    const data = await response.json() as { profile: DiscoveryProfile };
    setProfile(data.profile);
    setProfileDraft(data.profile);
    setProfileDirty(false);
    setMsg("발견 검색 설정을 저장했습니다.");
  }

  async function saveFeeds() {
    const list = feeds.split("\n").map((feed) => feed.trim()).filter((feed) => /^https?:\/\//.test(feed)).slice(0, 6);
    const response = await fetch("/api/discover/feeds", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feeds: list }),
    });
    if (!response.ok) {
      setFeedMsg("피드 저장에 실패했습니다.");
      return;
    }
    const data = await response.json() as { feeds?: string[] };
    const saved = data.feeds ?? [];
    setFeeds(saved.join("\n"));
    setFeedMsg(`${saved.length}개 사용자 피드를 저장했습니다.`);
  }

  const selected = useMemo(() => candidates.find((candidate) => candidate.id === selectedId) ?? null, [candidates, selectedId]);
  const selectedDecisionStatus = candidateDecisionStatus(selected);
  const document = selected && !(selected.status === "KEPT" && selected.sourceId) ? toReadingDocument(selected) : null;

  return (
    <div className="view-stack">
      <PageHeader title="발견" description="새로운 후보를 읽고, 다음 연구 행동을 바로 결정합니다." primaryAction={<button className="ui-button" disabled={busy || profileDirty} onClick={() => void runDiscovery()}>{profileDirty ? "설정을 먼저 저장" : busy ? "수집 요청 중…" : "지금 새로 찾기"}</button>} />
      <DiscoveryDirectionPanel profile={profileDraft} recommendations={recommendations} dirty={profileDirty} onChange={(next) => { setProfileDraft(next); setProfileDirty(true); }} onSave={() => void saveProfile()} />
      <div className="discovery-content-tabs" role="tablist" aria-label="발견 콘텐츠 종류">
        <button className={contentMode === "READING" ? "is-active" : ""} role="tab" aria-selected={contentMode === "READING"} onClick={() => setContentMode("READING")}>읽을거리</button>
        <button className={contentMode === "FIELD_SIGNAL" ? "is-active" : ""} role="tab" aria-selected={contentMode === "FIELD_SIGNAL"} onClick={() => setContentMode("FIELD_SIGNAL")}>현장 신호</button>
      </div>
      {msg && <p className="reservoir-message" role="status">{msg}</p>}
      {contentMode === "READING" && (
        <>
          <div className="discovery-toolbar">
            <div className="filter-strip" aria-label="후보 상태 필터">
              {STATUS_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${statusFilter === filter.value ? " is-active" : ""}`} onClick={() => setStatusFilter(filter.value)}>{filter.label}</button>)}
            </div>
            <div className="filter-strip" aria-label="발견 방향 필터">{LANE_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${laneFilter === filter.value ? " is-active" : ""}`} onClick={() => setLaneFilter(filter.value)}>{filter.label}</button>)}</div>
            <span className="table-note">저장 키워드 {profile.original.keywords.length + profile.counter.keywords.length}개 · 관련도 0.65 이상 · 무료 원문/PDF · 최대 8개/회</span>
          </div>
          {runSummary && <DiscoveryRunSummary collected={runCollected} diagnostics={runSummary} onAction={handleSummaryAction} />}
          {listError ? (
            <StatusMessage kind="error" title={listError} action={<button className="ui-button-secondary" onClick={() => void load()}>다시 시도</button>} />
          ) : (
            <SplitWorkspace
              readingKey={selectedId}
              mobilePane={selectedId ? "reading" : "index"}
              index={<SourceIndex title="발견 후보" items={candidates.map(toIndexItem)} selectedId={selectedId} onSelect={selectCandidate} />}
              reading={document ? <><ReadingActionBar statusLabel={selectedDecisionStatus ? DECISION_STATUS_LABELS[selectedDecisionStatus] : null} pending={busy} onBack={clearCandidateSelection} onOpenDecision={() => setDecisionOpen(true)} /><ReadingPane document={document} /></> : <StatusMessage kind="empty" title="읽을 후보를 선택하세요" description="왼쪽 목록에서 후보를 고르면 실제 접근 링크와 함께 읽기 질문을 확인할 수 있습니다." />}
            />
          )}
          {document && <DecisionBottomSheet actions={DISCOVERY_ACTIONS} document={document} decisionStatus={selectedDecisionStatus} open={decisionOpen} pending={busy} pendingAction={pendingAction} error={decisionError} onClose={() => setDecisionOpen(false)} onAction={(action) => void act(document.id, action)} />}
        </>
      )}
      {contentMode === "FIELD_SIGNAL" && (
        <>
          <div className="discovery-toolbar">
            <div className="filter-strip" aria-label="현장 신호 상태 필터">
              {FIELD_SIGNAL_STATUS_FILTERS.map((filter) => <button key={filter.value} className={`filter-button${fieldSignalStatus === filter.value ? " is-active" : ""}`} onClick={() => updateFieldSignalFilter(filter.value, fieldSignalType)}>{filter.label}</button>)}
            </div>
            <select aria-label="현장 신호 유형" value={fieldSignalType} onChange={(event) => updateFieldSignalFilter(fieldSignalStatus, event.target.value as "" | DiscoveryFieldSignalType)}>
              {FIELD_SIGNAL_TYPE_FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
            </select>
            <span className="table-note">회당 최대 12개 · 출처당 최대 4개</span>
          </div>
          {fieldSignalRunSummary && <FieldSignalRunSummary collected={fieldSignalsCollected} diagnostics={fieldSignalRunSummary} />}
          {fieldSignalError ? (
            <StatusMessage kind="error" title={fieldSignalError} action={<button className="ui-button-secondary" onClick={() => void loadFieldSignals()}>다시 시도</button>} />
          ) : (
            <FieldSignalList items={fieldSignals} status={fieldSignalStatus} pendingId={pendingFieldSignalId} onAction={(id, action) => void actOnFieldSignal(id, action)} />
          )}
        </>
      )}
      <details className="discovery-settings">
        <summary>발견 범위와 수집 출처 조정</summary>
        <div className="discovery-settings__grid">
          <section><h2>사용자 추가 RSS·Atom 피드</h2><p>검증된 기본 피드는 자동으로 적용됩니다. 여기는 별도 공개 피드만 한 줄에 하나씩, 최대 6개 추가합니다. 접근이 확인되지 않은 HTML은 읽을거리 후보가 되지 않습니다.</p><textarea value={feeds} onChange={(event) => setFeeds(event.target.value)} placeholder="https://some-journal.org/rss" /><button className="ui-button-secondary" onClick={() => void saveFeeds()}>피드 저장</button>{feedMsg && <span className="table-note">{feedMsg}</span>}</section>
        </div>
        <section className="discovery-sources"><h2>추천 출처 · 수집 상태</h2><p>공개 피드는 자동 수집하고, 기관형 데이터베이스는 공식 연동 상태를 구분해 표시합니다.</p>{DISCOVERY_SOURCE_PRESETS.map((source: DiscoverySourcePreset) => <div className="discovery-source__row" key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a><span>{source.description} · {sourceCollectionLabel(source)}</span></div>)}</section>
        {homepageProjects.length > 0 && <section className="discovery-sources"><h2>내 홈페이지 기반 출발점</h2><p>홈페이지에서 추출된 프로젝트가 발견 검색의 맥락으로 사용됩니다{homepageExtractedAt ? ` · 마지막 추출 ${new Date(homepageExtractedAt).toLocaleDateString("ko-KR")}` : ""}.</p>{homepageProjects.slice(0, 5).map((project) => <div className="discovery-source__row" key={project.slug}><a href={project.projectUrl} target="_blank" rel="noreferrer">{project.title} ↗</a><span>{project.year ?? "연도 미상"} · 이미지 {project.imageCount} · 영상 {project.videoCount}</span></div>)}</section>}
      </details>
    </div>
  );
}
