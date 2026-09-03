import type { RefObject } from "react";
import type { HomepagePublicationAction } from "../../lib/homepagePublication";

export interface HomepagePublicationPanelProps {
  action: HomepagePublicationAction | null;
  loading: boolean;
  previewPending: boolean;
  feedback: { kind: "status" | "error"; message: string } | null;
  availabilityNote?: string | null;
  publishTriggerRef: RefObject<HTMLButtonElement | null>;
  withdrawTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenPreview(): void;
  onOpenWithdraw(): void;
  onRetryStatus(): void;
}

export default function HomepagePublicationPanel({
  action,
  loading,
  previewPending,
  feedback,
  availabilityNote,
  publishTriggerRef,
  withdrawTriggerRef,
  onOpenPreview,
  onOpenWithdraw,
  onRetryStatus,
}: HomepagePublicationPanelProps) {
  return <section className="homepage-publication-panel" aria-labelledby="homepage-publication-title">
    <div className="homepage-publication-panel__heading">
      <div>
        <p className="reading-section__label">홈페이지 연결</p>
        <h2 id="homepage-publication-title">홈페이지로 내보내기</h2>
        <p>검토한 현재 연구만 홈페이지의 공개본으로 반영합니다. 공개되는 내용은 미리보기에서 확인할 수 있습니다.</p>
      </div>
      {loading && <span className="homepage-publication-panel__badge">확인 중</span>}
    </div>
    {loading && <p className="homepage-publication-panel__announcement" role="status" aria-live="polite">공개 상태 확인 중…</p>}
    {!loading && action && <div className="homepage-publication-panel__actions">
      <div className="homepage-publication-panel__state" role="status" aria-live="polite">
        <strong>{action.label}</strong>
        {action.kind === "OLD" && <span>{availabilityNote ?? "가장 최근에 완료된 Distill만 공개할 수 있습니다."}</span>}
      </div>
      {action.enabled && <button ref={publishTriggerRef} type="button" className="ui-button" aria-label="홈페이지로 내보내기" disabled={previewPending} onClick={onOpenPreview}>{action.kind === "UPDATE" ? "새 결과로 업데이트" : "홈페이지에 반영"}</button>}
      {action.kind === "CURRENT" && <button ref={withdrawTriggerRef} type="button" className="ui-button-danger-outline" disabled={previewPending} onClick={onOpenWithdraw}>홈페이지 공개 철회</button>}
    </div>}
    {previewPending && <p className="homepage-publication-panel__announcement" role="status" aria-live="polite">미리보기를 불러오는 중…</p>}
    {feedback && <p className={feedback.kind === "error" ? "homepage-publication-panel__error" : "homepage-publication-panel__announcement"} role={feedback.kind === "error" ? "alert" : "status"} aria-live={feedback.kind === "error" ? undefined : "polite"}>{feedback.message}</p>}
    {!loading && !action && <div className="homepage-publication-panel__retry"><p className="homepage-publication-panel__error" role="alert">홈페이지 공개 상태를 확인하지 못했습니다.</p><button type="button" className="ui-button-secondary" onClick={onRetryStatus}>다시 확인</button></div>}
  </section>;
}
