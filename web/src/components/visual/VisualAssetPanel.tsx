import { useEffect, useRef, useState } from "react";
import type { VisualAssetDetail, VisualAssetSummary } from "@radar/shared";
import VisualInspector from "./VisualInspector";

interface VisualAssetPanelProps {
  assets: VisualAssetSummary[];
  title?: string;
  onAnalysisAction?: (assetId: string, action: "accept" | "dismiss") => void | Promise<void>;
  onAssetUpdated?: (asset: VisualAssetSummary) => void;
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

function useCompactInspector() {
  const [compact, setCompact] = useState(() => window.innerWidth <= 900);
  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

export default function VisualAssetPanel({
  assets,
  title = "시각 자료",
  onAnalysisAction,
  onAssetUpdated,
}: VisualAssetPanelProps) {
  const [localAssets, setLocalAssets] = useState(assets);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VisualAssetDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const compact = useCompactInspector();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreScrollRef = useRef(0);
  const requestRef = useRef(0);

  useEffect(() => {
    setLocalAssets(assets);
  }, [assets]);

  if (localAssets.length === 0) return null;

  function replaceAsset(nextAsset: VisualAssetSummary) {
    setLocalAssets((current) => current.map((asset) => (asset.id === nextAsset.id ? nextAsset : asset)));
    onAssetUpdated?.(nextAsset);
  }

  async function openInspector(asset: VisualAssetSummary, trigger: HTMLButtonElement | null) {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setSelectedId(asset.id);
    setLoading(true);
    setError("");
    setDetail(null);
    triggerRef.current = trigger;
    restoreScrollRef.current = listRef.current?.scrollTop ?? 0;
    try {
      const response = await fetch(`/api/visual-assets/${asset.id}`);
      if (!response.ok) throw new Error("visual_detail_failed");
      const data = await response.json() as { asset?: VisualAssetDetail };
      if (requestRef.current !== requestId) return;
      setDetail(data.asset ?? null);
      setLoading(false);
    } catch {
      if (requestRef.current !== requestId) return;
      setError("시각 자료 상세를 불러오지 못했습니다.");
      setLoading(false);
    }
  }

  function closeInspector() {
    setSelectedId(null);
    setDetail(null);
    setLoading(false);
    setError("");
    if (listRef.current) listRef.current.scrollTop = restoreScrollRef.current;
    triggerRef.current?.focus();
  }

  async function saveAnalysis(payload: unknown) {
    if (!selectedId) return;
    const response = await fetch(`/api/visual-assets/${selectedId}/analysis`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "edit", payload }),
    });
    if (!response.ok) throw new Error("visual_analysis_save_failed");
    const data = await response.json() as { asset?: VisualAssetSummary };
    if (data.asset) replaceAsset(data.asset);
    if (!data.asset || !selectedId) return;
    await openInspector(data.asset, triggerRef.current);
  }

  async function retryProcessing() {
    if (!selectedId) return;
    const response = await fetch(`/api/visual-assets/${selectedId}/retry`, { method: "POST" });
    if (!response.ok) throw new Error("visual_retry_failed");
  }

  return (
    <section className="visual-asset-panel" aria-label={title}>
      <div className="visual-asset-panel__heading">
        <div>
          <p className="reading-section__label">멀티모달 자료</p>
          <h3>{title}</h3>
        </div>
        <span className="table-note">{localAssets.length}개</span>
      </div>

      <div className={`visual-workspace${selectedId && !compact ? " visual-workspace--inspecting" : ""}`}>
        <div className="visual-asset-grid" ref={listRef}>
          {localAssets.map((asset) => (
            <article className="visual-asset-card" key={asset.id}>
              <button
                type="button"
                className={`visual-asset-card__button${selectedId === asset.id ? " is-selected" : ""}`}
                aria-pressed={selectedId === asset.id}
                onClick={(event) => void openInspector(asset, event.currentTarget)}
              >
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
                  {asset.analysis && <small className="visual-asset-card__suggestion">{asset.analysis.reviewStatus === "EDITED" || asset.analysis.reviewStatus === "ACCEPTED" ? "사용자 검증본 있음" : "AI 제안 · 검토 전"}</small>}
                </div>
              </button>
              {asset.analysis?.reviewStatus === "PENDING" && onAnalysisAction && (
                <div className="visual-asset-card__actions">
                  <button type="button" className="ui-button-secondary" onClick={() => void onAnalysisAction(asset.id, "dismiss")}>보류</button>
                  <button type="button" className="ui-button" onClick={() => void onAnalysisAction(asset.id, "accept")}>제안 채택</button>
                </div>
              )}
            </article>
          ))}
        </div>

        {selectedId && (
          <VisualInspector
            asset={detail}
            loading={loading}
            error={error}
            compact={compact}
            onClose={closeInspector}
            onRetry={retryProcessing}
            onSaveAnalysis={saveAnalysis}
          />
        )}
      </div>
    </section>
  );
}
