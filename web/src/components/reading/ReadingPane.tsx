import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import SourceAccessBadge, { SourceAcquisitionBadge } from "./SourceAccessBadge";
import ProvenanceNotice from "./ProvenanceNotice";
import type { ReadingDocument } from "./types";
import DeepAnalysisPanel, { type DeepAnalysisViewModel } from "./DeepAnalysisPanel";

function StoredOriginalText({ url, initialText }: { url: string; initialText?: string | null }) {
  const [text, setText] = useState<string | null>(initialText ?? null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">(initialText !== undefined && initialText !== null ? "loaded" : "idle");
  const currentUrl = useRef(url);

  useEffect(() => {
    currentUrl.current = url;
    setText(initialText ?? null);
    setStatus(initialText !== undefined && initialText !== null ? "loaded" : "idle");
  }, [initialText, url]);

  async function loadOnOpen(event: SyntheticEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open || status !== "idle") return;
    const requestedUrl = url;
    setStatus("loading");
    try {
      const response = await fetch(requestedUrl);
      if (!response.ok) throw new Error("original_text_failed");
      const nextText = await response.text();
      if (currentUrl.current !== requestedUrl) return;
      setText(nextText);
      setStatus("loaded");
    } catch {
      if (currentUrl.current === requestedUrl) setStatus("error");
    }
  }

  return (
    <details className="reading-pane__original-text" onToggle={(event) => void loadOnOpen(event)}>
      <summary>저장된 원문 보기</summary>
      <div className="reading-pane__original-text-body">
        <a href={url} target="_blank" rel="noreferrer">텍스트 새 창에서 열기</a>
        {status === "loading" ? <p role="status">저장된 원문을 불러오는 중입니다.</p> : null}
        {status === "error" ? <p role="alert">저장된 원문을 불러오지 못했습니다.</p> : null}
        {text !== null ? <pre>{text}</pre> : null}
      </div>
    </details>
  );
}

export default function ReadingPane({ document, deepAnalysis, deepAnalysisHistory = [], onOpenDeepHistory, supplementary }: { document: ReadingDocument; deepAnalysis?: DeepAnalysisViewModel | null; deepAnalysisHistory?: { id: string; model?: string; createdAt: string; costUsd?: number }[]; onOpenDeepHistory?: (id: string) => void; supplementary?: ReactNode }) {
  const acquisitionProvenance = document.acquisition
    ? `원문 범위 ${document.acquisition.textScope} · 수집 방식 ${document.acquisition.extractionMethod} · 품질 ${document.acquisition.qualityStatus}`
    : undefined;
  return (
    <article className="reading-pane" aria-labelledby="reading-pane-title">
      <header className="reading-pane__header">
        <p className="reading-pane__kicker">현재 자료</p>
        <h2 id="reading-pane-title">{document.title}</h2>
        {document.originalTitle && document.originalTitle !== document.title && <p className="reading-pane__original-title"><span>원문 제목</span>{document.originalTitle}</p>}
        <p className="reading-pane__byline">{document.byline || "저자·출처 정보 없음"}</p>
        <div className="reading-pane__source">
          <SourceAccessBadge access={document.access} />
          {document.acquisition ? <SourceAcquisitionBadge acquisition={document.acquisition} /> : null}
        </div>
      </header>
      <ProvenanceNotice acquisition={acquisitionProvenance}>{document.provenance}</ProvenanceNotice>
      <div className="reading-pane__body">
        {document.acquisition?.originalTextUrl
          ? <StoredOriginalText url={document.acquisition.originalTextUrl} initialText={document.originalText} />
          : null}
        {supplementary}
        <section className="reading-section">
          <p className="reading-section__label">시스템 해석</p>
          {document.summary ? <p className="reading-section__summary">{document.summary}</p> : <p className="reading-section__empty"><strong>분석 내용 없음</strong><span>원문을 읽고 직접 판단해 주세요.</span></p>}
        </section>
        {document.fragments.length > 0 && <section className="reading-section"><p className="reading-section__label">원문에서 추출한 문장</p>{document.fragments.map((fragment, index) => <blockquote key={`${fragment}-${index}`}>{fragment}</blockquote>)}</section>}
        {document.questions.length > 0 && <section className="reading-section"><p className="reading-section__label">읽으며 붙잡을 질문</p>{document.questions.map((question, index) => <p className="reading-question" key={`${question}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{question}</p>)}</section>}
        {document.keywords.length > 0 && <section className="reading-section"><p className="reading-section__label">연결된 키워드</p><div className="reading-keywords">{document.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></section>}
        {deepAnalysis !== undefined && <DeepAnalysisPanel analysis={deepAnalysis} history={deepAnalysisHistory} onOpenHistory={onOpenDeepHistory} />}
      </div>
    </article>
  );
}
