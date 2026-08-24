interface ReadingActionBarProps {
  statusLabel?: string | null;
  message?: string;
  pending?: boolean;
  onBack: () => void;
  onOpenDecision?: () => void;
}

export default function ReadingActionBar({
  statusLabel = null,
  message,
  pending = false,
  onBack,
  onOpenDecision,
}: ReadingActionBarProps) {
  return (
    <div className="reading-action-bar" aria-label="읽기 행동">
      <button type="button" className="ui-button-secondary reading-action-bar__back" onClick={onBack}>목록으로</button>
      <span>{message ?? (statusLabel ? `현재 판단 · ${statusLabel}` : "아직 판단하지 않음")}</span>
      {onOpenDecision && <button type="button" className="ui-button" disabled={pending} onClick={onOpenDecision}>
        {statusLabel ? "판단 변경" : "판단하기"}
      </button>}
    </div>
  );
}
