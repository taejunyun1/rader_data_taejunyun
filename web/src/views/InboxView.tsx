import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { InboxDetail, InboxItem } from "@radar/shared";
import { extractPdfText, fileToBase64, renderPdfPreview } from "../lib/pdf";
import PageHeader from "../components/layout/PageHeader";
import StatusMessage from "../components/ui/StatusMessage";
import IngestionReviewPane from "../components/inbox/IngestionReviewPane";
import VisualUploadQueue from "../components/visual/VisualUploadQueue";
import { INGEST_CHANNEL_LABELS, INPUT_FORMAT_LABELS, QUALITY_STATUS_LABELS, labelOf } from "../lib/labels";

type CaptureMode = "memo" | "url" | "file" | "image";

const STATUS_LABEL: Record<string, string> = {
  received: "접수됨",
  stored: "원본 보존됨",
  extracted: "텍스트 추출됨",
  analyzed: "분석됨",
  indexed: "색인됨",
  failed: "처리 실패",
};

export default function InboxView() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [mode, setMode] = useState<CaptureMode>("memo");
  const [channelFilter, setChannelFilter] = useState("");
  const [qualityFilter, setQualityFilter] = useState("");
  const [msg, setMsg] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const detailRequestRef = useRef(0);

  async function load() {
    try {
      const query = new URLSearchParams();
      if (channelFilter) query.set("channel", channelFilter);
      if (qualityFilter) query.set("quality", qualityFilter);
      const response = await fetch(`/api/inbox${query.size ? `?${query.toString()}` : ""}`);
      const data = await response.json() as { items?: InboxItem[] };
      const nextItems = data.items ?? [];
      setItems(nextItems);
      if (selectedId && !nextItems.some((item) => item.sourceId === selectedId)) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch {
      setItems([]);
    }
  }

  async function loadDetail(sourceId: string) {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setSelectedId(sourceId);
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    setMsg("자료를 여는 중입니다.");
    try {
      const response = await fetch(`/api/inbox/${sourceId}`);
      if (!response.ok) throw new Error("detail_failed");
      const nextDetail = await response.json() as InboxDetail;
      if (requestId !== detailRequestRef.current) return;
      setDetail(nextDetail);
    } catch {
      if (requestId !== detailRequestRef.current) return;
      setDetailError("검수 정보를 불러오지 못했습니다. 목록에서 다시 선택해 주세요.");
      setMsg("자료의 검수 정보를 불러오지 못했습니다.");
    } finally {
      if (requestId === detailRequestRef.current) setDetailLoading(false);
    }
  }

  useEffect(() => { void load(); }, [channelFilter, qualityFilter]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function notify(message: string) {
    setMsg(message);
    setToast(message);
  }

  async function post(path: string, body: unknown) {
    setBusy(true);
    setMsg("");
    try {
      const response = await fetch(`/api/inbox${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        setMsg(`처리하지 못했습니다: ${String(data.error ?? response.status)}`);
        return null;
      }
      return data;
    } catch (error) {
      setMsg(`연결하지 못했습니다: ${(error as Error).message}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh(sourceId?: string) {
    await load();
    if (sourceId) await loadDetail(sourceId);
  }

  async function addNote() {
    if (!text.trim()) return;
    const data = await post("/text", { text, title: title || undefined });
    if (data) {
      notify(data.duplicateOf ? "이미 저장된 자료와 연결했습니다." : `메모를 보존했습니다: ${String(data.title)}`);
      setTitle("");
      setText("");
      await refresh(String(data.sourceId ?? ""));
    }
  }

  async function addUrl() {
    if (!url.trim()) return;
    const data = await post("/url", { url });
    if (data) {
      notify(data.error ? `원문을 가져오지 못했지만 재시도할 수 있게 남겼습니다: ${String(data.error)}` : data.duplicateOf ? "이미 저장된 자료와 연결했습니다." : `원문을 보존했습니다: ${String(data.title)}`);
      setUrl("");
      await refresh(String(data.sourceId ?? ""));
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        if (/\.(md|markdown|txt)$/i.test(file.name)) {
          const data = await post("/file", { filename: file.name, text: await file.text() });
          if (data) notify(data.duplicateOf ? "이미 저장된 자료와 연결했습니다." : `${file.name}을 보존했습니다.`);
        } else if (/\.pdf$/i.test(file.name)) {
          setMsg(`${file.name}에서 텍스트를 추출하는 중입니다.`);
          const extracted = await extractPdfText(file);
          const hasText = extracted.text.replace(/\[page \d+\]|\s/g, "").length >= 20;
          if (file.size > 29_000_000) throw new Error("PDF는 29MB 이하만 받을 수 있습니다.");
          const [originalBase64, previewBase64] = await Promise.all([fileToBase64(file), renderPdfPreview(file)]);
          const data = await post("/file", { filename: file.name, text: hasText ? extracted.text : undefined, originalBase64, previewBase64, contentType: "application/pdf" });
          if (data) notify(data.duplicateOf ? "이미 저장된 자료와 연결했습니다." : hasText ? `${file.name}의 텍스트·작은 미리보기·비공개 원본 PDF를 보존했습니다. (${extracted.pageCount}쪽)` : `${file.name}은 텍스트가 없는 PDF입니다. 작은 미리보기와 비공개 원본 PDF를 보존했습니다.`);
        } else {
          setMsg(`${file.name}: 지원하지 않는 파일 형식입니다.`);
        }
      } catch (error) {
        setMsg(`${file.name}: 처리하지 못했습니다. ${(error as Error).message}`);
      }
    }
    event.target.value = "";
    await refresh();
  }

  async function runAction(path: string, success: string) {
    if (!selectedId) return;
    const data = await post(path, {});
    if (data) {
      notify(success);
      await refresh(selectedId);
    }
  }

  return <div className="view-stack">
    {toast && <div className="inbox-toast" role="alert">{toast}</div>}
    <PageHeader title="받은 자료" description="메모, 링크, 파일을 형식별로 받고 원본·추출문·정규화문을 따로 검수합니다." />
    <div className="inbox-toolbar">
      <div><p className="reading-section__label">수신 자료 검수</p><strong>읽기 전에 자료의 상태를 확인하세요</strong></div>
      <div className="inbox-filters">
        <label>들어온 경로<select value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)}><option value="">전체 경로</option>{Object.entries(INGEST_CHANNEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>텍스트 상태<select value={qualityFilter} onChange={(event) => setQualityFilter(event.target.value)}><option value="">전체 상태</option>{Object.entries(QUALITY_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
    </div>
    <div className="inbox-layout inbox-layout--review">
      <section className="inbox-capture" aria-label="자료 입력">
        <div className="inbox-tabs" role="tablist" aria-label="자료 받기 방식">
          <button className={mode === "memo" ? "inbox-tabs__active" : ""} role="tab" aria-selected={mode === "memo"} onClick={() => setMode("memo")}>메모·텍스트</button>
          <button className={mode === "url" ? "inbox-tabs__active" : ""} role="tab" aria-selected={mode === "url"} onClick={() => setMode("url")}>웹 주소</button>
          <button className={mode === "file" ? "inbox-tabs__active" : ""} role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")}>파일</button>
          <button className={mode === "image" ? "inbox-tabs__active" : ""} role="tab" aria-selected={mode === "image"} onClick={() => setMode("image")}>이미지</button>
        </div>
        {mode === "memo" && <>
          <label>제목<span className="table-note">선택</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="자료를 구분할 제목" /></label>
          <label>내용<textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="읽은 문장이나 메모를 붙여 넣으세요" /></label>
          <button className="ui-button" disabled={busy || !text.trim()} onClick={() => void addNote()}>메모 보존하기</button>
          <p className="inbox-capture__hint">플레인 텍스트로 정규화한 뒤 분석합니다.</p>
        </>}
        {mode === "url" && <>
          <label>웹 주소<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" /></label>
          <button className="ui-button" disabled={busy || !url.trim()} onClick={() => void addUrl()}>원문 가져와 보존하기</button>
          <p className="inbox-capture__hint">HTML 원문과 읽을 수 있는 텍스트를 함께 남깁니다.</p>
        </>}
        {mode === "file" && <>
          <label>파일 선택<input ref={fileRef} type="file" accept=".md,.markdown,.txt,.pdf" multiple onChange={(event) => void onFile(event)} /></label>
          <div className="inbox-format-guide"><strong>지원 형식</strong><span>마크다운·플레인 텍스트</span><span>텍스트 PDF·스캔 PDF</span><small>PDF 원본은 R2에 보존합니다. 스캔 PDF는 OCR 없이 검토 상태로 남깁니다.</small></div>
        </>}
        {mode === "image" && <VisualUploadQueue onComplete={async () => { notify("이미지를 보존했습니다. 형태 분석이 끝나면 저장소에서 제안을 확인할 수 있습니다."); await refresh(); }} />}
      </section>
      <div className="inbox-workspace">
      <section className="inbox-list" aria-label="최근 들어온 자료">
        <div className="inbox-list__heading"><div><p className="reading-section__label">처리 목록</p><h2>최근 들어온 자료</h2></div><span className="table-note">{items.length}개</span></div>
        {msg && <p className="reservoir-message" role="status">{msg}</p>}
        {items.length === 0 ? <StatusMessage kind="empty" title="아직 들어온 자료가 없습니다" description="왼쪽에서 메모, 링크, 파일을 추가해 보세요." /> : <div className="inbox-items">{items.map((item) => <button className={`inbox-item inbox-item--button${selectedId === item.sourceId ? " is-selected" : ""}`} key={item.sourceId} onClick={() => void loadDetail(item.sourceId)}>
          <div className="inbox-item__body"><span className={`status-dot status-dot--${item.status}`} /> <strong>{item.title}</strong><p>{STATUS_LABEL[item.status] ?? item.status} · {labelOf(INGEST_CHANNEL_LABELS, item.ingestChannel)} · {labelOf(INPUT_FORMAT_LABELS, item.inputFormat)} · {labelOf(QUALITY_STATUS_LABELS, item.qualityStatus)} · {item.createdAt?.slice(0, 10)}</p>{Boolean(item.pendingVersionCount) && <span className="inbox-item__review">검토 대기 {item.pendingVersionCount}개</span>}{item.error && <span className="inbox-item__error">{item.error.slice(0, 120)}</span>}</div><span className="inbox-item__chevron" aria-hidden="true">→</span>
        </button>)}</div>}
      </section>
      <aside className={`inbox-review-panel${selectedId || detailLoading || detailError ? " is-open" : ""}`} aria-label="자료 검수" aria-busy={detailLoading}>
        <button className="inbox-review-panel__close" onClick={() => { setSelectedId(null); setDetail(null); setDetailError(""); }} aria-label="검수 패널 닫기">×</button>
        {detail ? <><IngestionReviewPane detail={detail} busy={busy || detailLoading} onReextract={() => void runAction(`/${detail.item.sourceId}/reextract`, "원문을 다시 가져왔습니다.")} onRenormalize={() => void runAction(`/${detail.item.sourceId}/renormalize`, "정규화를 다시 실행했습니다.")} onAnalyze={() => void runAction(`/${detail.item.sourceId}/analyze`, "현재 버전을 다시 분석했습니다.")} onActivate={(versionId) => void runAction(`/${detail.item.sourceId}/versions/${versionId}/activate`, "선택한 버전을 현재 버전으로 바꿨습니다.")} onReject={(versionId) => void runAction(`/${detail.item.sourceId}/versions/${versionId}/reject`, "검토 대기 버전을 보류했습니다.")} /><button className="ui-button-secondary inbox-review-panel__exclude" disabled={busy} onClick={() => void runAction(`/${detail.item.sourceId}/exclude`, "자료를 받은 자료 목록에서 제외했습니다.")}>목록에서 제외</button></> : <div className="inbox-review-panel__state" aria-live="polite"><p className="reading-section__label">선택한 자료</p><strong>{detailLoading ? "자료를 여는 중입니다." : detailError ? "자료를 열지 못했습니다." : "자료를 선택하세요"}</strong><p>{detailLoading ? "원문·정규화문·버전 정보를 준비하고 있습니다." : detailError || "가운데 목록에서 자료를 고르면 이곳에서 바로 검수할 수 있습니다."}</p></div>}
      </aside>
      </div>
    </div>
  </div>;
}
