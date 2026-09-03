import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { HomepagePreviewResponse } from "@radar/shared";
import { useModalAccessibility } from "../reading/modalAccessibility";

export interface HomepagePreviewDialogProps {
  open: boolean;
  preview: HomepagePreviewResponse | null;
  pending: boolean;
  error: string;
  returnFocusTarget(): HTMLElement | null;
  onClose(): void;
  onConfirm(): void | Promise<void>;
}

const sections = [
  ["keywords", "키워드"],
  ["thoughts", "생각의 조각"],
  ["questions", "질문"],
  ["researchDirections", "연구 방향"],
  ["artworkDirections", "작업 방향"],
] as const;

export default function HomepagePreviewDialog({ open, preview, pending, error, returnFocusTarget, onClose, onConfirm }: HomepagePreviewDialogProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const safeClose = () => { if (!pending) onClose(); };
  const { handleKeyDown } = useModalAccessibility({
    open,
    dialogRef,
    layerRef,
    onClose: safeClose,
    returnFocusTarget,
    getInitialFocusTarget: () => headingRef.current,
    initialFocusDeps: [preview?.sessionId, pending],
  });

  useEffect(() => {
    if (!open) return;
    // The dialog is intentionally read-only until the user explicitly confirms.
    headingRef.current?.focus();
  }, [open]);

  if (!open || !globalThis.document.body) return null;
  return createPortal(
    <div ref={layerRef} className="homepage-publication-layer">
      <button type="button" className="homepage-publication-dialog__scrim" aria-label="홈페이지 미리보기 닫기" disabled={pending} onClick={safeClose} />
      <section ref={dialogRef} className="homepage-publication-dialog" role="dialog" aria-modal="true" aria-labelledby="homepage-preview-title" aria-describedby="homepage-preview-description" tabIndex={-1} onKeyDown={handleKeyDown}>
        <div className="homepage-publication-dialog__heading">
          <div>
            <p className="reading-section__label">홈페이지 공개 미리보기</p>
            <h2 ref={headingRef} id="homepage-preview-title" tabIndex={-1}>현재 연구</h2>
          </div>
          <button type="button" className="ui-button-secondary" disabled={pending} onClick={safeClose}>닫기</button>
        </div>
        <p id="homepage-preview-description" className="homepage-publication-dialog__description">아래 내용만 홈페이지에 공개됩니다. 공개 후에도 원본 자료와 내부 검토 기록은 Radar에 남습니다.</p>
        {preview && <>
          <div className="homepage-publication-preview" aria-label="공개되는 현재 연구">
            <h3>{preview.content.displayTitle}</h3>
            {sections.map(([key, label]) => {
              const values = preview.content[key];
              return values.length > 0 ? <section key={key}><p className="reading-section__label">{label}</p>{values.map((value) => <p className="distill-copy" key={value}>{value}</p>)}</section> : null;
            })}
            {preview.content.researchMaterials.length > 0 && <section><p className="reading-section__label">연구 자료</p><ul className="homepage-publication-preview__materials">{preview.content.researchMaterials.map((material) => <li key={`${material.url}-${material.title}`}><a href={material.url} target="_blank" rel="noreferrer">{material.title}</a>{material.author && <span> · {material.author}</span>}{material.year !== null && <span> · {material.year}</span>}</li>)}</ul></section>}
            <p className="homepage-publication-preview__disclaimer">원문은 복사하지 않고 출처 링크만 공개합니다. 출처의 직접 인용과 해석은 원문에서 확인해 주세요.</p>
            {preview.excludedResearchMaterialCount > 0 && <p className="table-note">공개 기준에 맞지 않아 제외된 연구 자료 {preview.excludedResearchMaterialCount}개</p>}
          </div>
          {(preview.privateReview.overall || preview.privateReview.warnings.length > 0) && <section className="homepage-publication-preview__private" aria-label="공개되지 않는 검토 메모"><p className="reading-section__label">공개되지 않는 검토 메모</p>{preview.privateReview.overall && <p>{preview.privateReview.overall}</p>}{preview.privateReview.warnings.map((warning) => <p key={`${warning.category}-${warning.note}`}>주의 · {warning.note}</p>)}</section>}
        </>}
        {pending && <p className="homepage-publication-dialog__announcement" role="status" aria-live="polite">반영 중…</p>}
        {error && <p className="homepage-publication-dialog__error" role="alert">{error}</p>}
        <div className="homepage-publication-dialog__actions"><button type="button" className="ui-button-secondary" disabled={pending} onClick={safeClose}>취소</button><button type="button" className="ui-button" disabled={pending || !preview} onClick={() => void onConfirm()}>{pending ? "반영 중…" : "공개 반영"}</button></div>
      </section>
    </div>,
    globalThis.document.body,
  );
}
