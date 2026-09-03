import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModalAccessibility } from "../reading/modalAccessibility";
import { formatHomepagePublicationDate } from "../../lib/homepagePublication";

export interface HomepageWithdrawalDialogProps {
  open: boolean;
  updatedAt: string | null;
  pending: boolean;
  error: string;
  returnFocusTarget(): HTMLElement | null;
  onClose(): void;
  onConfirm(): void | Promise<void>;
}

export default function HomepageWithdrawalDialog({ open, updatedAt, pending, error, returnFocusTarget, onClose, onConfirm }: HomepageWithdrawalDialogProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const safeClose = () => { if (!pending) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ open, dialogRef, layerRef, onClose: safeClose, returnFocusTarget });
  if (!open || !globalThis.document.body) return null;
  return createPortal(
    <div ref={layerRef} className="homepage-publication-layer">
      <button type="button" className="homepage-publication-dialog__scrim" aria-label="홈페이지 공개 철회 닫기" disabled={pending} onClick={safeClose} />
      <section ref={dialogRef} className="homepage-publication-dialog" role="dialog" aria-modal="true" aria-labelledby="homepage-withdraw-title" aria-describedby="homepage-withdraw-description" tabIndex={-1} onKeyDown={handleKeyDown}>
        <div className="homepage-publication-dialog__heading"><div><p className="reading-section__label">홈페이지 연결</p><h2 id="homepage-withdraw-title">현재 연구 공개 철회</h2></div><button type="button" className="ui-button-secondary" disabled={pending} onClick={safeClose}>닫기</button></div>
        <p id="homepage-withdraw-description">현재 연구 공개본을 홈페이지에서 내립니다. 홈페이지에는 빈 상태가 표시되며 비공개 발행 이력은 보존됩니다.</p>
        {updatedAt && <p className="table-note">마지막 업데이트 · {formatHomepagePublicationDate(updatedAt)}</p>}
        {pending && <p className="homepage-publication-dialog__announcement" role="status" aria-live="polite">철회 중…</p>}
        {error && <p className="homepage-publication-dialog__error" role="alert">{error}</p>}
        <div className="homepage-publication-dialog__actions"><button type="button" className="ui-button-secondary" disabled={pending} onClick={safeClose}>취소</button><button type="button" className="ui-button-danger" disabled={pending} onClick={() => void onConfirm()}>{pending ? "철회 중…" : "홈페이지 공개 철회"}</button></div>
      </section>
    </div>,
    globalThis.document.body,
  );
}
