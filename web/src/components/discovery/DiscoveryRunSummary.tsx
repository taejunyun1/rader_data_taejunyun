import type { DiscoveryDecisionReason } from "@radar/shared/discovery";
import type { DiscoveryRunDiagnostics } from "@radar/shared/discoveryRun";

interface DiscoveryRunSummaryProps {
  collected: number;
  diagnostics: DiscoveryRunDiagnostics;
  onAction: (action: "RETRY" | "EDIT_QUERY" | "OPEN_STATUS") => void;
}

const REASON_LABELS: Record<DiscoveryDecisionReason, string> = {
  RELEVANT: "관련 자료",
  NO_RESEARCH_ANCHOR: "연구축 표현 부족",
  BLOCKED_DOMAIN: "연구 범위 밖",
  ENGINEERING_ONLY: "공학 중심 자료",
  LOW_SCORE: "관련도 기준 미달",
  PAYWALLED: "유료 접근",
  ACCESS_UNKNOWN: "접근 확인 불가",
};

const PROVIDER_LABELS = { openalex: "OpenAlex", arxiv: "arXiv", rss: "RSS" } as const;

function reasonEntries(diagnostics: DiscoveryRunDiagnostics): Array<[DiscoveryDecisionReason, number]> {
  return (Object.entries(diagnostics.rejectedByReason) as Array<[DiscoveryDecisionReason, number | undefined]>)
    .filter((entry): entry is [DiscoveryDecisionReason, number] => Boolean(entry[1]));
}

function actionFor(diagnostics: DiscoveryRunDiagnostics): { action: DiscoveryRunSummaryProps["onAction"] extends (action: infer Action) => void ? Action : never; label: string } {
  const failedRequests = Object.values(diagnostics.providers).reduce((sum, stats) => sum + stats.failedRequests, 0);
  if (failedRequests > 0) return { action: "RETRY", label: "잠시 후 다시 찾기" };
  if (diagnostics.unsupportedQueries > 0) return { action: "EDIT_QUERY", label: "검색 설정에서 짧은 개념어로 수정" };
  const accessCount = (diagnostics.rejectedByReason.PAYWALLED ?? 0) + (diagnostics.rejectedByReason.ACCESS_UNKNOWN ?? 0);
  if (accessCount > 0) return { action: "OPEN_STATUS", label: "직접 읽기 출처 확인" };
  const qualityCount = ["NO_RESEARCH_ANCHOR", "ENGINEERING_ONLY", "LOW_SCORE", "BLOCKED_DOMAIN"]
    .reduce((sum, reason) => sum + (diagnostics.rejectedByReason[reason as DiscoveryDecisionReason] ?? 0), 0);
  if (qualityCount > 0) return { action: "EDIT_QUERY", label: "탈락 기준 확인" };
  const duplicateCount = Object.values(diagnostics.providers).reduce((sum, stats) => sum + stats.duplicate, 0);
  if (duplicateCount > 0) return { action: "OPEN_STATUS", label: "보관됨·관찰 중 후보 보기" };
  const quotaCount = Object.values(diagnostics.providers).reduce((sum, stats) => sum + stats.quotaExcluded, 0);
  if (quotaCount > 0) return { action: "RETRY", label: "다음 실행에서 더 보기" };
  return { action: "RETRY", label: "검색 설정을 넓혀 다시 찾기" };
}

export default function DiscoveryRunSummary({ collected, diagnostics, onAction }: DiscoveryRunSummaryProps) {
  const action = actionFor(diagnostics);
  const providerReceived = Object.entries(diagnostics.providers).map(([key, stats]) => `${PROVIDER_LABELS[key as keyof typeof PROVIDER_LABELS]} ${stats.received}건`).join(" · ");
  const reasons = reasonEntries(diagnostics);

  return (
    <section className="discovery-run-summary" aria-label="발견 수집 결과">
      <div className="discovery-run-summary__header">
        <div>
          <p className="reading-section__label">발견 수집 결과</p>
          <strong>새 후보 {collected}개</strong>
          {diagnostics.incomplete && <span className="discovery-run-summary__warning">일부 출처 확인 실패</span>}
          <p>{providerReceived || "확인한 출처 없음"}</p>
        </div>
        <button className="ui-button-secondary" type="button" onClick={() => onAction(action.action)}>{action.label}</button>
      </div>
      <details open={collected === 0}>
        <summary>진단 상세</summary>
        <div className="discovery-run-summary__body">
          <div className="discovery-run-summary__metrics">
            <span>검색 계획 {diagnostics.plannedQueries}개</span>
            <span>실행 {diagnostics.executedQueries}개</span>
            <span>변환 가능 {diagnostics.readyQueries}개</span>
            <span>변환 불가 {diagnostics.unsupportedQueries}개</span>
          </div>
          <div className="discovery-run-summary__providers">
            {Object.entries(diagnostics.providers).map(([key, stats]) => <div key={key}><strong>{PROVIDER_LABELS[key as keyof typeof PROVIDER_LABELS]}</strong><span>요청 {stats.requests} · 성공 {stats.succeededRequests} · 수신 {stats.received} · 선정 {stats.selected}</span></div>)}
          </div>
          <div className="discovery-run-summary__reasons" aria-label="후보 탈락 사유">
            {reasons.length > 0 ? reasons.map(([reason, count]) => <span key={reason}><span>{REASON_LABELS[reason]}</span> {count}</span>) : <span>정상 응답이었지만 기준에 맞는 새 후보가 없었습니다.</span>}
          </div>
        </div>
      </details>
    </section>
  );
}
