import { useEffect, useState, type ReactNode } from "react";
import type { VisualAnalysisSummary, VisualAssetDetail } from "@radar/shared";
import PdfCropPreview from "./PdfCropPreview";
import VisualAnalysisEditor from "./VisualAnalysisEditor";

interface VisualInspectorProps {
  asset: VisualAssetDetail | null;
  loading: boolean;
  error: string;
  compact: boolean;
  onClose: () => void;
  onRetry: () => Promise<void>;
  onSaveAnalysis: (payload: unknown) => Promise<void>;
  supplementaryContent?: ReactNode;
}

type AnalysisTab = "userVerified" | "autoSuggestion";

const PROCESSING_HINTS: Record<string, string> = {
  UPLOADED: "원본은 보존됐지만 미리보기 준비 전입니다.",
  TRANSFORM_PENDING: "원본 확인 → 미리보기 생성 → 분석 저장 순서로 준비를 시작할 수 있습니다.",
  TRANSFORMING: "원본 확인 → 미리보기 생성 단계에서 진행 중입니다.",
  ANALYSIS_PENDING: "미리보기는 준비됐고 분석 저장 단계만 남았습니다.",
  ANALYZING: "분석 저장 단계가 진행 중입니다.",
  READY: "",
  FAILED: "원본 확인 → 미리보기 생성 → 분석 저장 단계 중 하나에서 멈췄습니다.",
};

const EXTRACTION_STATUS_LABELS: Record<string, string> = {
  UPLOADING: "업로드 중",
  QUEUED: "대기 중",
  RUNNING: "처리 중",
  SUCCEEDED: "완료",
  PARTIAL: "부분 완료",
  FAILED: "실패",
  CANCELLED: "취소됨",
};

const SECTION_LABELS: Record<string, string> = {
  subject: "관찰",
  composition: "구도",
  color: "색",
  texture: "질감",
  spatialRelation: "공간 관계",
  material: "재료",
  lighting: "빛",
  visibleText: "읽히는 텍스트",
  shapes: "형태",
  lines: "선",
  planes: "면",
  rhythm: "리듬",
  scale: "스케일",
  density: "밀도",
  edges: "경계",
  contrast: "대비",
  perspective: "원근",
  medium: "매체",
  process: "과정",
  relationToPhotography: "사진과의 관계",
  culturalReferences: "문화 참조",
};

function analysisSummaryPayload(analysis: VisualAnalysisSummary | null): Record<string, unknown> | null {
  return analysis?.payload && typeof analysis.payload === "object" ? analysis.payload : null;
}

function analysisItems(payload: Record<string, unknown> | null, groupKey: "observation" | "formal" | "context"): Array<{ label: string; values: string[] }> {
  const group = payload?.[groupKey];
  if (!group || typeof group !== "object") return [];
  return Object.entries(group as Record<string, unknown>)
    .map(([key, value]) => ({
      label: SECTION_LABELS[key] ?? key,
      values: Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [],
    }))
    .filter((item) => item.values.length > 0);
}

function arrayItems(payload: Record<string, unknown> | null, key: "propositions" | "uncertainty"): string[] {
  const values = payload?.[key];
  return Array.isArray(values) ? values.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function previewMode(asset: VisualAssetDetail): "pdf" | "link" | "image" | "none" {
  if (asset.storageState === "LINK_ONLY" && asset.originKind === "PDF_PAGE_CROP" && asset.bbox && asset.pageNumber && asset.parentSourceId && asset.parentVersionId) {
    return "pdf";
  }
  if (asset.storageState === "LINK_ONLY") return "link";
  if (asset.thumbnailUrl) return "image";
  return "none";
}

export default function VisualInspector({ asset, loading, error, compact, onClose, onRetry, onSaveAnalysis, supplementaryContent }: VisualInspectorProps) {
  const [tab, setTab] = useState<AnalysisTab>("autoSuggestion");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!asset) return;
    setTab(asset.userVerified ? "userVerified" : "autoSuggestion");
    setEditing(false);
  }, [asset]);

  const role = compact ? "dialog" : "complementary";
  const activeAnalysis = tab === "userVerified" ? asset?.userVerified ?? asset?.autoSuggestion ?? null : asset?.autoSuggestion ?? asset?.userVerified ?? null;
  const payload = analysisSummaryPayload(activeAnalysis);
  const observation = analysisItems(payload, "observation");
  const formal = analysisItems(payload, "formal");
  const context = analysisItems(payload, "context");
  const propositions = arrayItems(payload, "propositions");
  const uncertainty = arrayItems(payload, "uncertainty");

  return (
    <aside
      className={`visual-inspector${compact ? " visual-inspector--sheet" : ""}`}
      role={role}
      aria-modal={compact ? "true" : undefined}
      aria-label="시각 자료 상세"
    >
      <div className="visual-inspector__header">
        <div>
          <p className="reading-section__label">시각 자료 상세</p>
          <h4>{asset?.caption || "시각 자료"}</h4>
        </div>
        <button type="button" className="ui-button-secondary" onClick={onClose}>닫기</button>
      </div>

      {loading && <p className="visual-inspector__hint">시각 자료 상세를 불러오는 중입니다.</p>}
      {error && !loading && <p className="visual-inspector__error">{error}</p>}

      {!loading && !error && asset && (
        <>
          <div className="visual-inspector__meta">
            <span>{asset.originKind}</span>
            <span>{asset.storageState}</span>
            <span>{asset.processingStatus}</span>
            <span>{asset.rightsStatus}</span>
          </div>

          <ProvenanceSection asset={asset} />

          {asset.processingStatus === "FAILED" && (
            <section className="visual-inspector__failure">
              <h5>처리 흐름 안내</h5>
              <p>{PROCESSING_HINTS[asset.processingStatus]}</p>
              <button type="button" className="ui-button" onClick={() => void onRetry()}>다시 처리</button>
            </section>
          )}

          {previewMode(asset) === "image" && asset.thumbnailUrl && (
            <figure className="visual-inspector__preview">
              <img src={asset.thumbnailUrl} alt={asset.caption || "시각 자료 미리보기"} />
              <figcaption>캡슐 이미지를 미리 보여 줍니다.</figcaption>
            </figure>
          )}

          {previewMode(asset) === "pdf" && asset.pageNumber && asset.bbox && asset.parentSourceId && asset.parentVersionId && (
            <PdfCropPreview
              sourceId={asset.parentSourceId}
              versionId={asset.parentVersionId}
              pageNumber={asset.pageNumber}
              bbox={asset.bbox}
            />
          )}

          {previewMode(asset) === "link" && (
            <section className="visual-inspector__link-only">
              <h5>원문 문맥</h5>
              {asset.caption && <p>{asset.caption}</p>}
              {asset.nearbyText && <p>{asset.nearbyText}</p>}
              {asset.sourceUrl && <a href={asset.sourceUrl} target="_blank" rel="noreferrer">원문에서 보기</a>}
            </section>
          )}

          {(asset.autoSuggestion || asset.userVerified) && (
            <>
              <div className="visual-inspector__tabs" role="tablist" aria-label="분석 버전">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "userVerified"}
                  className={tab === "userVerified" ? "is-active" : ""}
                  onClick={() => setTab("userVerified")}
                  disabled={!asset.userVerified}
                >
                  사용자 검증
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "autoSuggestion"}
                  className={tab === "autoSuggestion" ? "is-active" : ""}
                  onClick={() => setTab("autoSuggestion")}
                  disabled={!asset.autoSuggestion}
                >
                  AI 제안
                </button>
              </div>

              {!editing && activeAnalysis && (
                <div className="visual-inspector__analysis">
                  <div className="visual-inspector__analysis-header">
                    <div>
                      <p className="reading-section__label">{tab === "userVerified" ? "사용자 검증" : "AI 제안"}</p>
                      <h5>{tab === "userVerified" ? "검증본" : "자동 제안"}</h5>
                    </div>
                    <button type="button" className="ui-button-secondary" onClick={() => setEditing(true)}>분석 수정</button>
                  </div>

                  <AnalysisSection title="관찰" items={observation} />
                  <AnalysisSection title="형식" items={formal} />
                  <AnalysisSection title="맥락" items={context} />
                  <StringSection title="제안" items={propositions} />
                  <section className="visual-inspector__evidence">
                    <h5>근거 / 불확실성</h5>
                    {asset.selectionReason && <p>선정 사유 · {asset.selectionReason}</p>}
                    {asset.rightsBasis && <p>권리 근거 · {asset.rightsBasis}</p>}
                    {asset.figureLabel && <p>도판 표기 · {asset.figureLabel}</p>}
                    <StringList items={uncertainty} />
                  </section>
                </div>
              )}

              {editing && activeAnalysis && (
                <VisualAnalysisEditor
                  analysis={activeAnalysis}
                  onCancel={() => setEditing(false)}
                  onSave={async (payload) => {
                    await onSaveAnalysis(payload);
                    setEditing(false);
                  }}
                />
              )}
            </>
          )}
          {supplementaryContent}
        </>
      )}
    </aside>
  );
}

function AnalysisSection({ title, items }: { title: string; items: Array<{ label: string; values: string[] }> }) {
  if (items.length === 0) return null;
  return (
    <section className="visual-inspector__section">
      <h5>{title}</h5>
      <div className="visual-inspector__chips">
        {items.flatMap((item) => item.values.map((value) => (
          <span className="visual-inspector__chip" key={`${item.label}-${value}`}>
            <strong>{item.label}</strong>
            {value}
          </span>
        )))}
      </div>
    </section>
  );
}

function StringSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="visual-inspector__section">
      <h5>{title}</h5>
      <StringList items={items} />
    </section>
  );
}

function StringList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="visual-inspector__hint">기록된 항목이 없습니다.</p>;
  return (
    <div className="visual-inspector__stack">
      {items.map((item) => <p key={item}>{item}</p>)}
    </div>
  );
}

function ProvenanceSection({ asset }: { asset: VisualAssetDetail }) {
  return (
    <section className="visual-inspector__provenance">
      <h5>출처와 처리 기록</h5>
      <div className="visual-inspector__provenance-block">
        <h6>후보 문맥</h6>
        {asset.candidateKey && <p>후보 키 · {asset.candidateKey}</p>}
        {asset.figureLabel && <p>도판 표기 · {asset.figureLabel}</p>}
        {asset.pageNumber != null && <p>페이지 · {asset.pageNumber}</p>}
        {asset.rightsReviewedAt && <p>권리 검토 · {asset.rightsReviewedAt}</p>}
        {asset.sourceUrl && <p>원문 주소 · {asset.sourceUrl}</p>}
      </div>

      {asset.relations.length > 0 && (
        <div className="visual-inspector__provenance-block">
          <h6>관계</h6>
          {asset.relations.map((relation) => (
            <p key={relation.id}>
              {relation.relationKind} · {relation.description || relation.toVisualAssetId || relation.relatedSourceId || "연결된 자료"}
            </p>
          ))}
        </div>
      )}

      {asset.extractionRun && (
        <div className="visual-inspector__provenance-block">
          <h6>추출 실행</h6>
          <p>상태 · {EXTRACTION_STATUS_LABELS[asset.extractionRun.status] ?? asset.extractionRun.status}</p>
          <p>처리 · {asset.extractionRun.processedUnits} / {asset.extractionRun.totalUnits}</p>
          <p>선정 · {asset.extractionRun.selectedCount} · 검토 · {asset.extractionRun.reviewCount} · 제외 · {asset.extractionRun.filteredCount} · 사용 불가 · {asset.extractionRun.unavailableCount}</p>
          {asset.extractionRun.finishedAt && <p>완료 시각 · {asset.extractionRun.finishedAt}</p>}
          {asset.extractionRun.error && <p>실행 오류 · {asset.extractionRun.error}</p>}
        </div>
      )}
    </section>
  );
}
