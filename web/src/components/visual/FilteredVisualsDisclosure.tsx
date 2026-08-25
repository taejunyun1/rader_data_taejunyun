import { useMemo, useState } from "react";
import type { VisualAssetSummary } from "@radar/shared";

interface FilteredVisualsDisclosureProps {
  assets: VisualAssetSummary[];
  onRecover: (assetId: string, selectionStatus: "REVIEW" | "SELECTED") => Promise<void>;
}

function statusLabel(asset: VisualAssetSummary): string {
  if (asset.selectionStatus === "DECORATIVE") return "장식/광고";
  if (asset.selectionStatus === "DUPLICATE") return "중복";
  return "열 수 없음";
}

function reasonSummary(assets: VisualAssetSummary[]): string[] {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const label = statusLabel(asset);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count}개`);
}

export default function FilteredVisualsDisclosure({ assets, onRecover }: FilteredVisualsDisclosureProps) {
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const summaries = useMemo(() => reasonSummary(assets), [assets]);

  if (assets.length === 0) return null;

  async function recover(assetId: string, selectionStatus: "REVIEW" | "SELECTED") {
    setPendingId(assetId);
    try {
      await onRecover(assetId, selectionStatus);
    } finally {
      setPendingId((current) => (current === assetId ? null : current));
    }
  }

  return (
    <section className="filtered-visuals" aria-label="필터링된 이미지">
      <button
        type="button"
        className="ui-button-secondary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        필터링된 이미지 {assets.length}개
      </button>
      {open && (
        <div className="filtered-visuals__body">
          <div className="filtered-visuals__summary">
            {summaries.map((summary) => <span key={summary}>{summary}</span>)}
          </div>
          <ul className="filtered-visuals__list">
            {assets.map((asset) => (
              <li key={asset.id} className="filtered-visuals__item">
                <div>
                  <strong>{asset.caption || asset.figureLabel || "제목 없는 이미지"}</strong>
                  <p>{asset.selectionReason || statusLabel(asset)}</p>
                </div>
                {(asset.selectionStatus === "DECORATIVE" || asset.selectionStatus === "DUPLICATE") && (
                  <div className="filtered-visuals__actions">
                    <button
                      type="button"
                      className="ui-button-secondary"
                      disabled={pendingId === asset.id}
                      onClick={() => void recover(asset.id, "REVIEW")}
                    >
                      {`${asset.caption || asset.figureLabel || "이미지"} 검토 목록으로 복구`}
                    </button>
                    <button
                      type="button"
                      className="ui-button-secondary"
                      disabled={pendingId === asset.id}
                      onClick={() => void recover(asset.id, "SELECTED")}
                    >
                      {`${asset.caption || asset.figureLabel || "이미지"} 선택 목록으로 복구`}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
