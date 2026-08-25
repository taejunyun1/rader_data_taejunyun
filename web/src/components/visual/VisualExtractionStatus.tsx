import type { VisualAssetSummary, VisualExtractionRunSummary } from "@radar/shared";

interface VisualExtractionStatusProps {
  assets: VisualAssetSummary[];
  sourceKind: "WEB" | "PDF";
  run?: VisualExtractionRunSummary | null;
}

function linkOnlyRightsCount(assets: VisualAssetSummary[]): number {
  return assets.filter((asset) => (
    asset.storageState === "LINK_ONLY"
    && asset.selectionStatus !== "DECORATIVE"
    && asset.selectionStatus !== "DUPLICATE"
    && asset.rightsStatus !== "PERSONAL"
    && asset.rightsStatus !== "PERMITTED"
  )).length;
}

export default function VisualExtractionStatus({ assets, sourceKind, run = null }: VisualExtractionStatusProps) {
  const visibleAssets = assets.filter((asset) => asset.selectionStatus === "SELECTED" || asset.selectionStatus === "REVIEW");
  const filteredAssets = assets.filter((asset) => asset.selectionStatus === "DECORATIVE" || asset.selectionStatus === "DUPLICATE" || asset.selectionStatus === "UNAVAILABLE");
  const failedAssets = assets.filter((asset) => asset.processingStatus === "FAILED");
  const reviewCount = visibleAssets.filter((asset) => asset.selectionStatus === "REVIEW").length || Number(run?.reviewCount ?? 0);
  const rightsOnlyCount = linkOnlyRightsCount(visibleAssets);

  let title = "";
  let description = "";

  if (failedAssets.length > 0 || run?.status === "FAILED") {
    title = "처리 실패";
    description = "시각 자료를 다시 확인하거나 처리 단계를 다시 시작해야 합니다.";
  } else if (
    sourceKind === "WEB"
    && assets.length === 0
    && (!run || run.status === "QUEUED" || run.status === "RUNNING" || run.status === "UPLOADING")
  ) {
    title = "시각 자료 확인 중";
    description = "저장된 웹 원문에서 연구 가치가 있는 이미지를 추리는 중입니다.";
  } else if (sourceKind === "PDF" && assets.length === 0 && !run) {
    title = "PDF 시각 자료는 직접 시작해야 합니다.";
    description = "PDF는 브라우저에서 페이지를 나눠 올려야 해서 자동으로 시작하지 않습니다.";
  } else if (
    assets.length === 0
    && run
    && run.totalUnits === 0
    && run.selectedCount === 0
    && run.reviewCount === 0
    && run.filteredCount === 0
    && run.unavailableCount === 0
  ) {
    title = "이미지 없음";
    description = "추출할 만한 시각 자료를 찾지 못했습니다.";
  } else if (visibleAssets.length === 0 && filteredAssets.length > 0) {
    title = "모두 필터됨";
    description = "장식, 중복, 열 수 없는 이미지는 기본 목록에서 숨겨 두었습니다.";
  } else if (reviewCount > 0) {
    title = "일부 확인 필요";
    description = `${reviewCount}개의 이미지는 자동 판정만으로 확정하지 않고 검토 목록에 남겨 두었습니다.`;
  } else if (rightsOnlyCount > 0) {
    title = "권리 때문에 링크만 보존";
    description = "권리 근거가 없는 외부 이미지는 링크와 문맥만 남기고 미리보기 바이트는 저장하지 않았습니다.";
  } else {
    return null;
  }

  return (
    <section className="visual-extraction-status" aria-label="시각 자료 상태">
      <p className="reading-section__label">시각 자료 상태</p>
      <h3>{title}</h3>
      <p>{description}</p>
    </section>
  );
}
