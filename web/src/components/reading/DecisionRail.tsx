import type { ReactNode } from "react";
import type { DecisionAction } from "./types";

export const DEFAULT_DECISION_ACTIONS: DecisionAction[] = [
  { id: "develop", label: "발전시키기", description: "작업·연구 방향에 적극 반영" },
  { id: "keep", label: "보관하기", description: "다음 리서치까지 표시해 두기" },
  { id: "watch", label: "관찰하기", description: "관련 흐름이 생길 때 다시 보기" },
  { id: "ignore", label: "제외하기", description: "추천 우선순위만 낮추기" },
];

interface DecisionRailProps {
  actions?: DecisionAction[];
  pending?: boolean;
  onAction: (id: DecisionAction["id"]) => void | Promise<void>;
  secondaryAction?: { label: string; onClick: () => void | Promise<void> };
  children?: ReactNode;
}

export default function DecisionRail({ actions = DEFAULT_DECISION_ACTIONS, pending = false, onAction, secondaryAction, children }: DecisionRailProps) {
  return (
    <aside className="decision-rail" aria-label="읽은 뒤 판단">
      <h2>읽은 뒤 판단</h2>
      <p className="decision-rail__description">분류는 언제든 바꿀 수 있으며 원자료는 삭제되지 않습니다.</p>
      <div className="decision-rail__actions">
        {actions.map((action) => <button key={action.id} aria-label={action.label} className={`decision-rail__action decision-rail__action--${action.id}`} disabled={pending} onClick={() => void onAction(action.id)}><strong>{action.label}</strong><span>{action.description}</span></button>)}
      </div>
      {secondaryAction && <button className="decision-rail__secondary" disabled={pending} onClick={() => void secondaryAction.onClick()}>{secondaryAction.label}</button>}
      {children}
    </aside>
  );
}
