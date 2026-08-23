import type {
  DiscoveryFieldSignal,
  DiscoveryFieldSignalStatus,
  DiscoveryFieldSignalType,
} from "@radar/shared/fieldSignals";

const TYPE_LABELS: Record<DiscoveryFieldSignalType, string> = {
  CONFERENCE: "학회·심포지엄",
  CALL_FOR_PAPERS: "CFP",
  EXHIBITION: "전시",
  GRANT: "지원·펠로십",
  RESIDENCY: "레지던시",
  WORKSHOP: "워크숍",
  INSTITUTION_NEWS: "기관 소식",
  OTHER: "기타",
};

function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getUTCFullYear()}. ${date.getUTCMonth() + 1}. ${date.getUTCDate()}.`;
}

export default function FieldSignalList({
  items,
  status,
  pendingId,
  onAction,
}: {
  items: DiscoveryFieldSignal[];
  status: DiscoveryFieldSignalStatus;
  pendingId: string | null;
  onAction: (id: string, action: "save" | "dismiss" | "restore") => void;
}) {
  if (items.length === 0) {
    return <p className="discovery-field-signals__empty">표시할 현장 신호가 없습니다.</p>;
  }

  return (
    <section className="discovery-field-signals" aria-label="현장 신호 목록">
      {items.map((item) => {
        const published = dateLabel(item.publishedAt);
        const event = dateLabel(item.eventAt);
        const deadline = dateLabel(item.deadlineAt);
        const dates = [
          published ? { label: "게시", value: published } : null,
          event ? { label: "행사", value: event } : null,
          deadline ? { label: "마감", value: deadline } : null,
        ].filter(Boolean) as Array<{ label: string; value: string }>;

        return (
          <article className="discovery-field-signal" key={item.id}>
            <div className="discovery-field-signal__badges">
              <span>{TYPE_LABELS[item.signalType]}</span>
              <span>{item.sourceName}</span>
              <strong>관련도 {item.relevanceScore.toFixed(2)}</strong>
            </div>
            <h2>
              <a href={item.externalUrl} target="_blank" rel="noreferrer">{item.title}</a>
            </h2>
            {dates.length > 0 && (
              <p className="discovery-field-signal__dates">
                {dates.map((date, index) => (
                  <span key={`${date.label}-${date.value}`}>
                    {index > 0 && <span aria-hidden="true"> · </span>}
                    <span>{date.label} {date.value}</span>
                  </span>
                ))}
              </p>
            )}
            {item.summary && <p>{item.summary}</p>}
            {item.matchedTerms.length > 0 && (
              <div className="discovery-field-signal__terms">
                {item.matchedTerms.map((term) => <span key={term}>{term}</span>)}
              </div>
            )}
            <div className="discovery-field-signal__actions">
              {status === "NEW" && (
                <>
                  <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "save")}>신호 저장</button>
                  <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "dismiss")}>제외</button>
                </>
              )}
              {status === "SAVED" && (
                <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "dismiss")}>제외</button>
              )}
              {status === "DISMISSED" && (
                <button className="ui-button-secondary" disabled={pendingId === item.id} onClick={() => onAction(item.id, "restore")}>복구</button>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
