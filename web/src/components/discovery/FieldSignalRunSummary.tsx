import type { DiscoveryFieldSignalRunDiagnostics } from "@radar/shared/fieldSignals";

export default function FieldSignalRunSummary({
  collected,
  diagnostics,
}: {
  collected: number;
  diagnostics: DiscoveryFieldSignalRunDiagnostics;
}) {
  const sources = Object.entries(diagnostics.sources);

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
        <div className="discovery-run-summary__providers">
          {sources.map(([sourceId, stats]) => (
            <div key={sourceId}>
              <strong>{sourceId}</strong>
              <span>요청 {stats.requests} · 성공 {stats.succeededRequests} · 수신 {stats.received} · 선정 {stats.selected}</span>
              <span>전체 제외 {stats.rejected} · 오래됨 {stats.stale} · 종료됨 {stats.expired} · 중복 {stats.duplicate}</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
