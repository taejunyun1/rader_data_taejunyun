import type {
  DiscoveryFieldSignalRejectionReason,
  DiscoveryFieldSignalRunDiagnostics,
} from "@radar/shared/fieldSignals";

const REASON_LABELS: Record<DiscoveryFieldSignalRejectionReason, string> = {
  NO_RESEARCH_MATCH: "연구 일치 부족",
  STALE: "오래됨",
  EXPIRED: "종료됨",
  MISSING_URL: "링크 없음",
  DUPLICATE: "중복",
  SOURCE_QUOTA: "출처 상한",
};

function reasonEntries(diagnostics: DiscoveryFieldSignalRunDiagnostics): Array<[DiscoveryFieldSignalRejectionReason, number]> {
  return (Object.entries(diagnostics.rejectedByReason) as Array<[DiscoveryFieldSignalRejectionReason, number | undefined]>)
    .filter((entry): entry is [DiscoveryFieldSignalRejectionReason, number] => Boolean(entry[1]));
}

export default function FieldSignalRunSummary({
  collected,
  diagnostics,
}: {
  collected: number;
  diagnostics: DiscoveryFieldSignalRunDiagnostics;
}) {
  const sources = Object.entries(diagnostics.sources);
  const reasons = reasonEntries(diagnostics);

  return (
    <section className="discovery-run-summary" aria-label="현장 신호 수집 결과">
      <div className="discovery-run-summary__header">
        <div>
          <span className="eyebrow">현장 신호 수집</span>
          <strong>새 신호 {collected}개</strong>
        </div>
        {diagnostics.incomplete && <span className="discovery-run-summary__warning">일부 출처 확인 실패</span>}
      </div>
      <details open={collected === 0 || diagnostics.incomplete}>
        <summary>출처별 진단</summary>
        <div className="discovery-run-summary__body">
          <div className="discovery-run-summary__providers">
            {sources.map(([sourceId, stats]) => {
              const visibleErrors = stats.errorCodes.slice(0, 2);
              const extraErrors = stats.errorCodes.length - visibleErrors.length;
              return (
                <div key={sourceId}>
                  <strong>{sourceId}</strong>
                  <span>요청 {stats.requests} · 성공 {stats.succeededRequests} · 실패 {stats.failedRequests} · 수신 {stats.received} · 선정 {stats.selected}</span>
                  <span>전체 제외 {stats.rejected} · 오래됨 {stats.stale} · 종료됨 {stats.expired} · 링크 없음 {stats.missingUrl}</span>
                  <span>중복 {stats.duplicate} · 상한 제외 {stats.quotaExcluded}</span>
                  {stats.failedRequests > 0 && visibleErrors.length > 0 && (
                    <span>오류 {visibleErrors.join(", ")}{extraErrors > 0 ? ` +${extraErrors}` : ""}</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="discovery-run-summary__reasons" aria-label="현장 신호 탈락 사유">
            {reasons.length > 0
              ? reasons.map(([reason, count]) => <span key={reason}>{REASON_LABELS[reason]} {count}</span>)
              : <span>정상 응답이었지만 기준에 맞는 새 현장 신호가 없었습니다.</span>}
          </div>
        </div>
      </details>
    </section>
  );
}
