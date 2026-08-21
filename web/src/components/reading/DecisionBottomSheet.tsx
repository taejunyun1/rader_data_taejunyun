import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_DECISION_ACTIONS } from "./DecisionRail";
import type { DecisionAction, ReadingDocument } from "./types";

interface DecisionBottomSheetProps {
  document: ReadingDocument;
  actions?: DecisionAction[];
  open?: boolean;
  pending?: boolean;
  pendingAction?: DecisionAction["id"] | null;
  error?: string;
  onAction: (id: DecisionAction["id"]) => void | Promise<void>;
  onClose: () => void;
  secondaryAction?: { label: string; onClick: () => void | Promise<void> };
  children?: React.ReactNode;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
}

export default function DecisionBottomSheet({
  document: readingDocument,
  actions = DEFAULT_DECISION_ACTIONS,
  open = true,
  pending = false,
  pendingAction = null,
  error = "",
  onAction,
  onClose,
  secondaryAction,
  children,
}: DecisionBottomSheetProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const body = globalThis.document.body;
    returnFocusRef.current = globalThis.document.activeElement instanceof HTMLElement ? globalThis.document.activeElement : null;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    firstActionRef.current?.focus();
    return () => {
      body.style.overflow = previousOverflow;
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) firstActionRef.current?.focus();
  }, [open, readingDocument.id]);

  if (!open || !globalThis.document.body) return null;

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const elements = focusableElements(dialogRef.current);
    if (elements.length === 0) return;
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (event.shiftKey && globalThis.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && globalThis.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="decision-sheet-layer">
      <button className="decision-sheet__scrim" type="button" aria-label="배경을 눌러 닫기" onClick={onClose} />
      <section
        ref={dialogRef}
        className="decision-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-sheet-title"
        aria-describedby="decision-sheet-description"
        onKeyDown={handleKeyDown}
      >
        <div className="decision-sheet__handle" aria-hidden="true" />
        <button className="decision-sheet__close" type="button" aria-label="닫기" onClick={onClose}>×</button>
        <div className="decision-sheet__context">
          <div className="decision-sheet__source-icon" aria-hidden="true">◎</div>
          <div>
            <h3>{readingDocument.title}</h3>
            {readingDocument.originalTitle && <p className="decision-sheet__original-title">원문: {readingDocument.originalTitle}</p>}
            <p>{readingDocument.byline}</p>
          </div>
        </div>
        <div className="decision-sheet__heading">
          <h2 id="decision-sheet-title">읽은 뒤 판단</h2>
          <p id="decision-sheet-description">분류는 언제든 바꿀 수 있으며 원자료는 삭제되지 않습니다.</p>
        </div>
        <div className="decision-sheet__actions">
          {actions.map((action, index) => (
            <button
              key={action.id}
              ref={index === 0 ? firstActionRef : undefined}
              type="button"
              className={`decision-sheet__action decision-sheet__action--${action.id}`}
              disabled={pending}
              aria-label={action.label}
              onClick={() => void onAction(action.id)}
            >
              <strong>{pending && pendingAction === action.id ? "처리 중…" : action.label}</strong>
              <span>{action.description}</span>
            </button>
          ))}
        </div>
        {error && <p className="decision-sheet__error" role="alert">{error}</p>}
        {secondaryAction && <button className="decision-sheet__secondary" type="button" disabled={pending} onClick={() => void secondaryAction.onClick()}>{secondaryAction.label}</button>}
        {children}
      </section>
    </div>,
    globalThis.document.body,
  );
}
