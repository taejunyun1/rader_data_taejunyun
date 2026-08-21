import type { ReactNode } from "react";

type StatusKind = "loading" | "empty" | "error" | "success";

interface StatusMessageProps {
  kind: StatusKind;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function StatusMessage({ kind, title, description, action }: StatusMessageProps) {
  return (
    <section className={`status-message status-message--${kind}`} role={kind === "error" ? "alert" : undefined}>
      <p className="status-message__kind">{kind === "loading" ? "불러오는 중" : kind === "error" ? "문제가 발생했습니다" : kind === "success" ? "완료" : "아직 없음"}</p>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action && <div className="status-message__action">{action}</div>}
    </section>
  );
}
