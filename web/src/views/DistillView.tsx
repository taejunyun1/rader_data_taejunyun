import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DistillHomepagePublicationState, HomepagePreviewResponse, HomepagePublicationStatusResponse } from "@radar/shared";
import PageHeader from "../components/layout/PageHeader";
import StatusMessage from "../components/ui/StatusMessage";
import DocumentOutline from "../components/distill/DocumentOutline";
import SelectionTray from "../components/distill/SelectionTray";
import CounterSection from "../components/distill/CounterSection";
import HomepagePublicationPanel from "../components/distill/HomepagePublicationPanel";
import HomepagePreviewDialog from "../components/distill/HomepagePreviewDialog";
import HomepageWithdrawalDialog from "../components/distill/HomepageWithdrawalDialog";
import { labelOf, PRIORITY_LABELS, RESEARCH_GAP_LABELS } from "../lib/labels";
import { deriveHomepagePublicationAction, fetchHomepagePreview, fetchHomepagePublicationStatus, homepagePublicationErrorMessage, publishHomepagePreview, withdrawHomepagePublication } from "../lib/homepagePublication";

interface DistillOutput { keywords: string[]; thoughts_fragments: string[]; questions: string[]; read_next: { title: string; author?: string; why_read: string; related_question?: string }[]; research_gaps: { gap: string; kind: string }[]; research_directions: string[]; artwork_directions: string[]; small_experiment?: string; }
interface QueueItem { id: string; title: string; author: string | null; priority: string; whyRead: string | null; relatedQuestion: string | null; sourceUrl: string | null; openalexId: string | null; verified: number; }
interface CounterData { dominant_claim?: string; opposing_thesis?: string; incompatibility?: string; conditions?: string[]; axes: { from: string; to: string; rationale: string }[]; suggestions: { direction: string; grounding: { name: string; kind: string; note: string }[] }[]; validation?: { status: "verified" | "corrected" | "unverified"; issues?: string[] }; }
interface SessionData { session: { id: string; redistillOf: string | null; counterEnabled?: boolean; modelVersion: string; promptVersion: string; costUsd: number; createdAt: string; sourcesUsed: { id: string; title: string }[] | null; output: DistillOutput | null; critic: { warnings: { category: string; note: string }[]; overall: string } | null; counter: CounterData | null; homepagePublicationState?: DistillHomepagePublicationState; }; readingQueue: QueueItem[]; researchGaps: { id: string; gap: string; kind: string | null }[]; }
interface SessionListItem { id: string; redistillOf: string | null; counterEnabled?: boolean; costUsd: number; createdAt: string; homepagePublicationState?: DistillHomepagePublicationState; }
interface Budget { usedPct: number; budgetUsd: number; blocked: boolean; warn: boolean; }
type PublishSnapshot = Pick<HomepagePreviewResponse, "sessionId" | "contentHash" | "currentRevision">;
type WithdrawSnapshot = { expectedPublicationId: string; expectedContentHash: string; expectedCurrentRevision: string; updatedAt: string };

const SECTIONS = [{ id: "keywords", label: "키워드" }, { id: "thoughts", label: "생각의 조각" }, { id: "questions", label: "질문" }, { id: "reading-queue", label: "다음 읽기" }, { id: "research-gaps", label: "연구 공백" }, { id: "directions", label: "연구 방향" }, { id: "artwork", label: "작업 방향" }, { id: "experiment", label: "작은 실험" }];
const KEEP_OPTIONS = [{ id: "keywords", label: "키워드" }, { id: "thoughts_fragments", label: "생각의 조각" }, { id: "questions", label: "질문" }, { id: "read_next", label: "다음 읽기" }, { id: "research_gaps", label: "연구 공백" }, { id: "research_directions", label: "연구 방향" }, { id: "artwork_directions", label: "작업 방향" }, { id: "small_experiment", label: "작은 실험" }];

export default function DistillView({ onJobCreated, focusSessionId, onFocusConsumed }: { onJobCreated?: () => Promise<void>; focusSessionId?: string; onFocusConsumed?: () => void }) {
  const [data, setData] = useState<SessionData | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  const [kept, setKept] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [includeCounter, setIncludeCounter] = useState(true);
  const [publicationStatus, setPublicationStatus] = useState<HomepagePublicationStatusResponse | null>(null);
  const [publicationStatusLoading, setPublicationStatusLoading] = useState(false);
  const [publicationStatusError, setPublicationStatusError] = useState("");
  const [publicationFeedback, setPublicationFeedback] = useState<{ kind: "status" | "error"; message: string } | null>(null);
  const [preview, setPreview] = useState<HomepagePreviewResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [publishPending, setPublishPending] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawPending, setWithdrawPending] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [withdrawSnapshot, setWithdrawSnapshot] = useState<WithdrawSnapshot | null>(null);
  const generationRef = useRef(0);
  const selectedSessionIdRef = useRef<string | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const statusAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const publishTriggerRef = useRef<HTMLButtonElement | null>(null);
  const withdrawTriggerRef = useRef<HTMLButtonElement | null>(null);
  const distillBusy = busy;

  async function loadPublicationStatus(id: string, generation: number) {
    statusAbortRef.current?.abort();
    const controller = new AbortController();
    statusAbortRef.current = controller;
    setPublicationStatusLoading(true);
    setPublicationStatusError("");
    try {
      const next = await fetchHomepagePublicationStatus(controller.signal);
      if (generation !== generationRef.current || selectedSessionIdRef.current !== id) return;
      setPublicationStatus(next);
      if (next.ledgerReconcilePending) setPublicationFeedback({ kind: "status", message: next.current.state === "WITHDRAWN" ? "홈페이지 공개 철회는 완료됐습니다. 내부 기록을 확인 중입니다." : "홈페이지 상태는 확인했습니다. 내부 기록을 확인 중입니다." });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (generation !== generationRef.current || selectedSessionIdRef.current !== id) return;
      setPublicationStatus(null);
      setPublicationStatusError(homepagePublicationErrorMessage("status", error instanceof Error ? error.message : "status_failed"));
    } finally {
      if (generation === generationRef.current && selectedSessionIdRef.current === id) setPublicationStatusLoading(false);
    }
  }

  async function openSession(id: string) {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    selectedSessionIdRef.current = id;
    detailAbortRef.current?.abort();
    statusAbortRef.current?.abort();
    previewAbortRef.current?.abort();
    detailAbortRef.current = new AbortController();
    setData(null);
    setPublicationStatus(null);
    setPublicationStatusError("");
    setPublicationFeedback(null);
    setPreview(null);
    setPreviewOpen(false);
    setPreviewError("");
    setWithdrawOpen(false);
    setWithdrawError("");
    setWithdrawSnapshot(null);
    try {
      const response = await fetch(`/api/distill/sessions/${encodeURIComponent(id)}`, { signal: detailAbortRef.current.signal });
      if (!response.ok) return;
      const next = await response.json() as SessionData;
      if (generation !== generationRef.current || selectedSessionIdRef.current !== id) return;
      setData(next);
      setIncludeCounter(next.session.counterEnabled ?? true);
      void loadPublicationStatus(id, generation);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError") && generation === generationRef.current) setPublicationStatusError("착즙 결과를 불러오지 못했습니다.");
    }
  }
  const loadSessions = useCallback(async () => { const response = await fetch("/api/distill/sessions"); if (!response.ok) return; const result = await response.json() as { sessions?: SessionListItem[] }; const next = result.sessions ?? []; setSessions(next); const focus = focusSessionId && next.some((session) => session.id === focusSessionId) ? focusSessionId : next[0]?.id; if (focus) { await openSession(focus); if (focusSessionId === focus) onFocusConsumed?.(); } }, [focusSessionId, onFocusConsumed]);
  useEffect(() => { void loadSessions(); fetch("/api/distill/budget").then((response) => response.json() as Promise<Budget>).then(setBudget).catch(() => setBudget(null)); }, [loadSessions]);

  async function runDistill(redistillOf?: string) {
    if (budget?.blocked) { setMsg("이번 달 AI 사용량 한도에 도달해 착즙을 실행할 수 없습니다."); return; }
    setBusy(true);
    try {
      const body = redistillOf ? { redistillOf, keepElements: kept, includeCounter } : { includeCounter };
      const response = await fetch("/api/distill/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { job?: unknown; reused?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "착즙 실행을 시작하지 못했습니다.");
      await onJobCreated?.();
      setKept([]);
      setMsg(result.reused ? "이미 진행 중인 착즙 작업을 계속합니다." : "착즙을 시작했습니다. 완료되면 상단 작업센터에서 결과를 확인할 수 있습니다.");
      fetch("/api/distill/budget").then((item) => item.json() as Promise<Budget>).then(setBudget).catch(() => undefined);
    } catch (error) { setMsg(error instanceof Error ? error.message : "착즙을 시작하지 못했습니다."); } finally { setBusy(false); }
  }

  async function verifyQueue() { if (!data) return; setMsg("다음 읽기 후보를 확인하는 중입니다."); const response = await fetch(`/api/distill/verify-queue/${data.session.id}`, { method: "POST" }); const result = await response.json() as { verified?: number; total?: number }; setMsg(`${result.verified ?? 0}/${result.total ?? 0}개 후보를 확인했습니다.`); await openSession(data.session.id); }
  async function importQueueItem(item: QueueItem) { if (!item.verified) return; setMsg("저장소에 보관하는 중입니다."); const response = await fetch(`/api/distill/queue-import/${item.id}`, { method: "POST" }); const result = await response.json() as { status?: string; detail?: string }; setMsg(result.status === "imported" ? "저장소에 보관했습니다. 분석이 이어집니다." : result.status === "duplicate" ? "이미 저장소에 있는 자료입니다." : `보관하지 못했습니다: ${result.detail ?? response.status}`); }
  async function saveSelection() { if (!data) return; await fetch(`/api/distill/sessions/${data.session.id}/select`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kept }) }); setMsg("선택 범위를 저장했습니다."); }

  async function openHomepagePreview() {
    const current = data;
    if (!current || !publicationStatus) return;
    const id = current.session.id;
    const generation = generationRef.current;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewPending(true);
    setPreviewError("");
    setPublicationFeedback(null);
    try {
      const next = await fetchHomepagePreview(id, controller.signal);
      if (generation !== generationRef.current || selectedSessionIdRef.current !== id) return;
      setPreview(next);
      setPreviewOpen(true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (generation === generationRef.current && selectedSessionIdRef.current === id) setPublicationFeedback({ kind: "error", message: homepagePublicationErrorMessage("preview", error instanceof Error ? error.message : "preview_failed") });
    } finally {
      if (generation === generationRef.current && selectedSessionIdRef.current === id) setPreviewPending(false);
    }
  }

  async function confirmHomepagePublish() {
    const snapshot: PublishSnapshot | null = preview ? { sessionId: preview.sessionId, contentHash: preview.contentHash, currentRevision: preview.currentRevision } : null;
    if (!snapshot) return;
    const generation = generationRef.current;
    const id = snapshot.sessionId;
    setPublishPending(true);
    setPreviewError("");
    try {
      const result = await publishHomepagePreview(id, { expectedContentHash: snapshot.contentHash, expectedCurrentRevision: snapshot.currentRevision });
      if (generation === generationRef.current && selectedSessionIdRef.current === id) {
        setPreviewOpen(false);
        setPreview(null);
        setPublicationFeedback({ kind: "status", message: result.ledgerReconcilePending ? (publicationStatus?.current.state === "PUBLISHED" ? "홈페이지 반영은 완료됐습니다. 내부 기록을 확인 중입니다." : "홈페이지 반영은 완료됐습니다. 내부 기록을 확인 중입니다.") : publicationStatus && publicationStatus.current.state === "PUBLISHED" ? "홈페이지의 현재 연구를 새 결과로 업데이트했습니다." : "홈페이지에 현재 연구를 반영했습니다." });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "publish_failed";
      if (generation === generationRef.current && selectedSessionIdRef.current === id) {
        if (code === "preview_stale" || code === "publication_state_changed" || code === "publication_purged") {
          setPreviewOpen(false);
          setPreview(null);
          setPublicationFeedback({ kind: "error", message: homepagePublicationErrorMessage("publish", code) });
        } else setPreviewError(homepagePublicationErrorMessage("publish", code));
      }
    } finally {
      if (generation === generationRef.current && selectedSessionIdRef.current === id) setPublishPending(false);
      const selected = selectedSessionIdRef.current;
      if (selected) void loadPublicationStatus(selected, generationRef.current);
    }
  }

  function openHomepageWithdrawal() {
    if (!publicationStatus || publicationStatus.current.state !== "PUBLISHED") return;
    const current = publicationStatus.current;
    if (!data || current.distillSessionId !== data.session.id) return;
    setWithdrawSnapshot({ expectedPublicationId: current.publicationId, expectedContentHash: current.contentHash, expectedCurrentRevision: publicationStatus.currentRevision, updatedAt: current.updatedAt });
    setWithdrawError("");
    setWithdrawOpen(true);
  }

  async function confirmHomepageWithdrawal() {
    const snapshot = withdrawSnapshot;
    if (!snapshot) return;
    const generation = generationRef.current;
    setWithdrawPending(true);
    setWithdrawError("");
    try {
      const result = await withdrawHomepagePublication(snapshot);
      if (generation === generationRef.current) {
        setWithdrawOpen(false);
        setWithdrawSnapshot(null);
        setPublicationFeedback({ kind: "status", message: result.ledgerReconcilePending ? "홈페이지 공개 철회는 완료됐습니다. 내부 기록을 확인 중입니다." : "홈페이지 공개를 철회했습니다." });
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "withdraw_failed";
      if (generation === generationRef.current) {
        if (code === "withdrawal_stale" || code === "publication_state_changed") { setWithdrawOpen(false); setWithdrawSnapshot(null); }
        setWithdrawError(homepagePublicationErrorMessage("withdraw", code));
      }
    } finally {
      if (generation === generationRef.current) setWithdrawPending(false);
      const selected = selectedSessionIdRef.current;
      if (selected) void loadPublicationStatus(selected, generationRef.current);
    }
  }

  const output = data?.session.output;
  const publicationAction = useMemo(() => {
    if (!data || !publicationStatus) return null;
    return deriveHomepagePublicationAction({ sessionId: data.session.id, sessionState: data.session.homepagePublicationState ?? "NONE", status: publicationStatus });
  }, [data, publicationStatus]);
  const outline = SECTIONS.filter((section) => section.id === "keywords" ? output?.keywords.length : section.id === "thoughts" ? output?.thoughts_fragments.length : section.id === "questions" ? output?.questions.length : section.id === "reading-queue" ? data?.readingQueue.length : section.id === "research-gaps" ? data?.researchGaps.length : section.id === "directions" ? output?.research_directions.length : section.id === "artwork" ? output?.artwork_directions.length : Boolean(output?.small_experiment)).map((section) => ({ ...section, count: section.id === "keywords" ? output?.keywords.length : section.id === "reading-queue" ? data?.readingQueue.length : undefined }));

  return <div className="view-stack">
    <PageHeader title="착즙" description="보존한 자료에서 다음 읽기와 연구 방향을 편집합니다." primaryAction={<div className="distill-primary-actions"><label className="toggle-control"><input type="checkbox" role="switch" checked={includeCounter} onChange={(event) => setIncludeCounter(event.target.checked)} disabled={distillBusy} /><span>반대 관점 포함</span></label><button className="ui-button" disabled={distillBusy} onClick={() => void runDistill()}>{distillBusy ? "착즙 중…" : data ? "새로 착즙하기" : "첫 착즙 시작"}</button></div>} />
    {budget && <p className={`budget-note${budget.warn ? " is-warning" : ""}`}>AI 사용량 {budget.usedPct.toFixed(0)}% · 월 한도 ${budget.budgetUsd}{budget.blocked ? " · 한도 도달" : ""}</p>}
    {msg && <p className="reservoir-message" role="status">{msg}</p>}
    {sessions.length > 1 && <div className="session-strip" aria-label="착즙 기록">{sessions.slice(0, 6).map((session) => <button key={session.id} className="filter-button" onClick={() => void openSession(session.id)}>{new Date(session.createdAt).toLocaleDateString("ko-KR")} {session.redistillOf ? "↻" : ""}</button>)}</div>}
    {!data || !output ? <StatusMessage kind="empty" title="아직 착즙 결과가 없습니다" description="저장소의 자료를 바탕으로 첫 착즙을 시작하세요." /> : <div className="distill-document-layout"><DocumentOutline sections={[...outline, { id: "counter", label: "정면 반대 관점" }]} /><main className="distill-document"><p className="document-meta">생성 {new Date(data.session.createdAt).toLocaleString("ko-KR")} · 사용 모델 {data.session.modelVersion} · 비용 ${data.session.costUsd.toFixed(4)} · 자료 {data.session.sourcesUsed?.length ?? 0}개 · {data.session.counterEnabled === false ? "반대 관점 제외" : "반대 관점 포함"}</p>
      <HomepagePublicationPanel action={publicationAction} loading={publicationStatusLoading} previewPending={previewPending} feedback={publicationFeedback ?? (publicationStatusError ? { kind: "error", message: publicationStatusError } : null)} publishTriggerRef={publishTriggerRef} withdrawTriggerRef={withdrawTriggerRef} onOpenPreview={() => void openHomepagePreview()} onOpenWithdraw={openHomepageWithdrawal} onRetryStatus={() => void loadPublicationStatus(data.session.id, generationRef.current)} />
      {output.keywords.length > 0 && <section id="keywords" className="distill-section"><p className="reading-section__label">키워드</p><div className="reading-keywords">{output.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></section>}
      {output.thoughts_fragments.length > 0 && <section id="thoughts" className="distill-section"><p className="reading-section__label">생각의 조각</p>{output.thoughts_fragments.map((item) => <p className="distill-copy" key={item}>{item}</p>)}</section>}
      {output.questions.length > 0 && <section id="questions" className="distill-section"><p className="reading-section__label">질문</p>{output.questions.map((item, index) => <p className="reading-question" key={item}><span>{String(index + 1).padStart(2, "0")}</span>{item}</p>)}</section>}
      <section id="reading-queue" className="distill-section"><div className="distill-section__heading"><p className="reading-section__label">다음 읽기</p><button className="ui-button-secondary" onClick={() => void verifyQueue()}>접근 경로 다시 확인</button></div>{data.readingQueue.length === 0 ? <p className="distill-copy">추천된 다음 읽기가 없습니다.</p> : data.readingQueue.map((item) => <article className="queue-card" key={item.id}><div><h3>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.title}</a> : item.title}</h3><p>{item.author ?? "저자 정보 없음"} · {labelOf(PRIORITY_LABELS, item.priority)} · {item.verified ? "확인됨" : "미확인"}</p>{item.whyRead && <span>{item.whyRead}</span>}{item.relatedQuestion && <blockquote>{item.relatedQuestion}</blockquote>}</div><button className="ui-button-secondary" disabled={!item.verified} title={item.verified ? "저장소에 보관" : "먼저 접근 경로를 확인하세요"} onClick={() => void importQueueItem(item)}>{item.verified ? "저장소에 보관" : "확인 필요"}</button></article>)}</section>
      {data.researchGaps.length > 0 && <section id="research-gaps" className="distill-section"><p className="reading-section__label">연구 공백</p>{data.researchGaps.map((item) => <p className="distill-copy" key={item.id}>{item.gap}{item.kind && <span className="pill">{labelOf(RESEARCH_GAP_LABELS, item.kind)}</span>}</p>)}</section>}
      {output.research_directions.length > 0 && <section id="directions" className="distill-section"><p className="reading-section__label">연구 방향</p>{output.research_directions.map((item) => <p className="distill-copy" key={item}>{item}</p>)}</section>}
      {output.artwork_directions.length > 0 && <section id="artwork" className="distill-section"><p className="reading-section__label">작업 방향</p>{output.artwork_directions.map((item) => <p className="distill-copy" key={item}>{item}</p>)}</section>}
      {output.small_experiment && <section id="experiment" className="distill-section"><p className="reading-section__label">작은 실험</p><p className="distill-copy">{output.small_experiment}</p></section>}
      {data.session.critic && <section className="distill-section distill-section--note"><p className="reading-section__label">검토 메모</p><p className="distill-copy">{data.session.critic.overall}</p>{data.session.critic.warnings.map((warning) => <p className="table-note" key={`${warning.category}-${warning.note}`}>주의 · {warning.note}</p>)}</section>}
      <CounterSection counter={data.session.counter} enabled={data.session.counterEnabled !== false} />
      <SelectionTray options={KEEP_OPTIONS} selected={kept} pending={distillBusy} budgetBlocked={Boolean(budget?.blocked)} onToggle={(id) => setKept((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])} onSave={() => void saveSelection()} onRedistill={() => void runDistill(data.session.id)} />
      <button className="ui-button-secondary" onClick={() => window.open(`/api/distill/sessions/${data.session.id}/markdown`, "_blank")}>마크다운으로 내보내기</button>
    </main></div>}
    <HomepagePreviewDialog open={previewOpen} preview={preview} pending={publishPending} error={previewError} returnFocusTarget={() => publishTriggerRef.current} onClose={() => { if (!publishPending) setPreviewOpen(false); }} onConfirm={() => void confirmHomepagePublish()} />
    <HomepageWithdrawalDialog open={withdrawOpen} updatedAt={withdrawSnapshot?.updatedAt ?? null} pending={withdrawPending} error={withdrawError} returnFocusTarget={() => withdrawTriggerRef.current} onClose={() => { if (!withdrawPending) setWithdrawOpen(false); }} onConfirm={() => void confirmHomepageWithdrawal()} />
  </div>;
}
