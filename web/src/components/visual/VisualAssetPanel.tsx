import type { VisualAssetSummary } from "@radar/shared";

interface VisualAssetPanelProps {
  assets: VisualAssetSummary[];
  title?: string;
  onAnalysisAction?: (assetId: string, action: "accept" | "dismiss") => void | Promise<void>;
}

const PROCESSING_LABELS: Record<VisualAssetSummary["processingStatus"], string> = {
  UPLOADED: "업로드됨",
  TRANSFORM_PENDING: "변환 대기",
  TRANSFORMING: "미리보기 만드는 중",
  ANALYSIS_PENDING: "분석 대기",
  ANALYZING: "형태 분석 중",
  READY: "분석 준비됨",
  FAILED: "처리 실패",
};

const KIND_LABELS: Record<VisualAssetSummary["visualKind"], string> = {
  PHOTO: "사진",
  ARTWORK: "작품",
  INSTALLATION: "설치",
  GRAPHIC: "그래픽",
  DIAGRAM: "다이어그램",
  DOCUMENT_SCAN: "문서 이미지",
  OTHER: "분류 전",
};

function firstAnalysisText(asset: VisualAssetSummary): string | null {
  const payload = asset.analysis?.payload;
  if (!payload) return null;
  const observation = payload.observation;
  if (observation && typeof observation === "object") {
    for (const values of Object.values(observation)) {
      if (Array.isArray(values) && typeof values[0] === "string") return values[0];
    }
  }
  const propositions = payload.propositions;
  return Array.isArray(propositions) && typeof propositions[0] === "string" ? propositions[0] : null;
}

export default function VisualAssetPanel({ assets, title = "시각 자료", onAnalysisAction }: VisualAssetPanelProps) {
  if (assets.length === 0) return null;
  return (
    <section className="visual-asset-panel" aria-label={title}>
      <div className="visual-asset-panel__heading">
        <div>
          <p className="reading-section__label">멀티모달 자료</p>
          <h3>{title}</h3>
        </div>
        <span className="table-note">{assets.length}개</span>
      </div>
      <div className="visual-asset-grid">
        {assets.map((asset) => (
          <article className="visual-asset-card" key={asset.id}>
            <div className="visual-asset-card__media">
              {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt={asset.caption || `${KIND_LABELS[asset.visualKind]} 미리보기`} loading="lazy" /> : <span aria-hidden="true">◌</span>}
            </div>
            <div className="visual-asset-card__body">
              <div className="visual-asset-card__meta">
                <span>{KIND_LABELS[asset.visualKind]}</span>
                <span>{PROCESSING_LABELS[asset.processingStatus]}</span>
              </div>
              <strong>{asset.caption || "형태 제안 대기 중"}</strong>
              <p>{asset.processingStatus === "FAILED" ? "이미지 처리를 다시 시도해야 합니다." : firstAnalysisText(asset) || asset.selectionReason || "이미지의 형태·구성·분위기를 제안할 준비가 되었습니다."}</p>
              {asset.analysis && <small className="visual-asset-card__suggestion">AI 제안 · 검토 전</small>}
              {asset.analysis?.reviewStatus === "PENDING" && onAnalysisAction && <div className="visual-asset-card__actions">
                <button type="button" className="ui-button-secondary" onClick={() => void onAnalysisAction(asset.id, "dismiss")}>보류</button>
                <button type="button" className="ui-button" onClick={() => void onAnalysisAction(asset.id, "accept")}>제안 채택</button>
              </div>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
