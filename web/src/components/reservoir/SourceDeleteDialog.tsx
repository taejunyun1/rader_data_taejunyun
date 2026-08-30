import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalAccessibility } from "../reading/modalAccessibility";

export interface SourceDeleteDialogProps {
  open: boolean;
  sourceId: string;
  title: string;
  mergeRole: "NONE" | "CANONICAL" | "MEMBER";
  mergeMemberCount: number;
  pending: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (confirmTitle: string) => void | Promise<void>;
}

function mergeMessage(role: SourceDeleteDialogProps["mergeRole"], count: number): string {
  if (role === "CANONICAL" && count > 1) {
    return `현재 병합 그룹의 대표 자료입니다. 삭제 후 남은 ${count - 1}개 자료 중 새 대표를 선정합니다.`;
  }
  if (role === "MEMBER") {
    return "이 자료만 병합 그룹에서 제거하며 대표 자료와 다른 구성원은 보존합니다.";
  }
  return "다른 자료와 병합 관계가 없는 단독 자료입니다.";
}

export default function SourceDeleteDialog(props: SourceDeleteDialogProps) {
  const { open, sourceId, title, mergeRole, mergeMemberCount, pending, error, onClose, onConfirm } = props;
  const [confirmTitle, setConfirmTitle] = useState("");
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const safeClose = () => { if (!pending) onClose(); };

  useEffect(() => {
    if (open) setConfirmTitle("");
  }, [open, sourceId]);

  const { handleKeyDown } = useModalAccessibility({
    open,
    dialogRef,
    layerRef,
    onClose: safeClose,
    getInitialFocusTarget: () => inputRef.current,
    initialFocusDeps: [sourceId],
  });

  if (!open || !globalThis.document.body) return null;
  return createPortal(
    <div ref={layerRef} className="source-delete-layer">
      <button
        type="button"
        className="source-delete-dialog__scrim"
        aria-label="자료 삭제 닫기"
        disabled={pending}
        onClick={safeClose}
      />
      <section
        ref={dialogRef}
        className="source-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-delete-title"
        aria-describedby="source-delete-description"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id="source-delete-title">자료 영구 삭제</h2>
        <p id="source-delete-description">
          원문, 모든 버전, 분석, 키워드·질문·메모, 연결된 시각 자료와 R2 파일을 삭제합니다. 이 작업은 되돌릴 수 없습니다.
        </p>
        <div className="source-delete-dialog__source"><span>삭제 대상</span><strong>{title}</strong></div>
        <p className="source-delete-dialog__merge">{mergeMessage(mergeRole, mergeMemberCount)}</p>
        <label htmlFor="source-delete-confirmation">
          확인을 위해 자료 제목 입력
          <input
            ref={inputRef}
            id="source-delete-confirmation"
            value={confirmTitle}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => setConfirmTitle(event.target.value)}
          />
        </label>
        {error && <p className="source-delete-dialog__error" role="alert">{error}</p>}
        <div className="source-delete-dialog__actions">
          <button type="button" className="ui-button-secondary" disabled={pending} onClick={safeClose}>취소</button>
          <button
            type="button"
            className="ui-button-danger"
            disabled={pending || confirmTitle !== title}
            onClick={() => void onConfirm(confirmTitle)}
          >
            {pending ? "삭제 중…" : "영구 삭제"}
          </button>
        </div>
      </section>
    </div>,
    globalThis.document.body,
  );
}
