import type { PdfVisualExtractionResult } from "../../lib/pdfVisualExtraction";

interface PdfExtractionProgressProps {
  state: PdfVisualExtractionResult | null;
  busy: boolean;
  onStart: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
}

function progressLabel(state: PdfVisualExtractionResult | null): string {
  if (!state) return "PDF 원문에서 시각 자료 후보를 찾습니다.";
  return `${state.uploadedPages.toLocaleString("ko-KR")} / ${state.totalPages.toLocaleString("ko-KR")}페이지 업로드됨`;
}

export default function PdfExtractionProgress({ state, busy, onStart, onContinue, onStop }: PdfExtractionProgressProps) {
  const hasProgress = Boolean(state && state.totalPages > 0);
  const showContinue = Boolean(state && !busy && state.remainingPages > 0 && state.uploadedPages > 0);
  const isPaused = state?.status === "PAUSED";
  const isQueued = state?.status === "QUEUED" || state?.status === "RUNNING";
  const actionDisabled = busy || isQueued;

  return (
    <section className="reading-section" aria-label="PDF 시각 자료 추출">
      <p className="reading-section__label">멀티모달 자료</p>
      <div className="deep-analysis-controls">
        <button type="button" className="ui-button" disabled={actionDisabled} onClick={() => void (showContinue ? onContinue() : onStart())}>
          {isQueued ? "시각 후보 분석 중…" : showContinue ? "계속" : "시각 자료 찾기"}
        </button>
        {busy && (
          <button type="button" className="ui-button-secondary" onClick={() => void onStop()}>
            중지
          </button>
        )}
      </div>
      <p className="table-note" role="status">
        {progressLabel(state)}
      </p>
      {isPaused && <p className="table-note" role="status">페이지 준비가 잠시 멈췄습니다. 이어서 시작하면 저장된 페이지 다음부터 계속합니다.</p>}
      {isQueued && <p className="table-note" role="status">페이지 준비가 끝났습니다. 백그라운드에서 시각 후보를 분석하고 있습니다.</p>}
      {hasProgress && state?.remainingPages === 0 && (
        <p className="table-note">모든 페이지 업로드를 마쳤습니다.</p>
      )}
    </section>
  );
}
