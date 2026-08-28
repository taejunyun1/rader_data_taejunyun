import type { InboxDetail, InboxVersionSummary } from "@radar/shared";
import {
  INGEST_CHANNEL_LABELS,
  INPUT_FORMAT_LABELS,
  QUALITY_STATUS_LABELS,
  VERSION_ORIGIN_LABELS,
  VERSION_REVIEW_LABELS,
  labelOf,
} from "../../lib/labels";

interface IngestionReviewPaneProps {
  detail: InboxDetail;
  busy: boolean;
  onReextract: () => void;
  onRenormalize: () => void;
  onAnalyze: () => void;
  onActivate: (versionId: string) => void;
  onReject: (versionId: string) => void;
}

export default function IngestionReviewPane({ detail, busy, onReextract, onRenormalize, onAnalyze, onActivate, onReject }: IngestionReviewPaneProps) {
  const { item, activeVersion, versions } = detail;
  const pending = versions.filter((version) => version.reviewStatus === "PENDING_REVIEW");

  return (
    <section className="inbox-review" aria-label="자료 검수">
      <div className="inbox-review__heading">
        <div>
          <p className="reading-section__label">선택한 자료</p>
          <h2>{item.title}</h2>
          <p className="inbox-review__meta">
            {labelOf(INGEST_CHANNEL_LABELS, item.ingestChannel)} · {labelOf(INPUT_FORMAT_LABELS, item.inputFormat)} · {item.charCount?.toLocaleString() ?? 0}자
          </p>
        </div>
        {detail.original.available ? <a className="ui-button-secondary inbox-review__original" href={detail.original.url} target="_blank" rel="noreferrer">원본 열기</a> : <span className="table-note">{String(item.inputFormat ?? "").startsWith("PDF") ? "PDF 원본이 없어 다시 첨부가 필요함" : "원본 파일 없음"}</span>}
      </div>

      <div className="inbox-badges" aria-label="자료 상태">
        <span className={`inbox-badge inbox-badge--${String(item.qualityStatus ?? "UNREVIEWED").toLowerCase()}`}>{labelOf(QUALITY_STATUS_LABELS, item.qualityStatus)}</span>
        <span className="inbox-badge">버전 {item.versionCount ?? versions.length}</span>
        {item.analysisFresh ? <span className="inbox-badge inbox-badge--ready">현재 버전 분석됨</span> : <span className="inbox-badge">분석 대기</span>}
      </div>

      {pending.length > 0 && <section className="inbox-review__alert">
        <strong>검토 대기 버전 {pending.length}개</strong>
        <p>수동 편집본을 보호하기 위해 자동 동기화된 변경은 바로 적용하지 않았습니다.</p>
        <div className="inbox-version-list">{pending.map((version) => <VersionRow key={version.id} version={version} busy={busy} onActivate={onActivate} onReject={onReject} />)}</div>
      </section>}

      <div className="inbox-review__columns">
        <section className="inbox-review__block">
          <div className="inbox-review__block-heading"><div><p className="reading-section__label">처리 결과</p><h3>분석에 사용할 텍스트</h3></div><span className="table-note">원본은 수정하지 않습니다</span></div>
          <div className="inbox-text-preview">
            <p className="inbox-text-preview__label">정규화문</p>
            <pre>{activeVersion?.normalizedText || "정규화된 텍스트가 없습니다."}</pre>
          </div>
          <details className="inbox-source-details">
            <summary>추출문 원문 보기</summary>
            <pre>{activeVersion?.extractedText || "추출된 텍스트가 없습니다."}</pre>
          </details>
        </section>

        <section className="inbox-review__block">
          <div className="inbox-review__block-heading"><div><p className="reading-section__label">품질 리포트</p><h3>읽을 수 있는 상태인지</h3></div></div>
          <QualityReport detail={detail} />
          <div className="inbox-review__actions">
            <button className="ui-button" disabled={busy || !activeVersion} onClick={onAnalyze}>현재 버전 다시 분석</button>
            <button className="ui-button-secondary" disabled={busy || !activeVersion} onClick={onRenormalize}>정규화 다시 실행</button>
            {item.inputFormat === "URL_HTML" && <button className="ui-button-secondary" disabled={busy} onClick={onReextract}>웹 원문 다시 가져오기</button>}
          </div>
        </section>
      </div>

      <section className="inbox-review__block inbox-review__history">
        <div className="inbox-review__block-heading"><div><p className="reading-section__label">변경 이력</p><h3>버전은 삭제하지 않고 남깁니다</h3></div></div>
        <div className="inbox-version-list">{versions.map((version) => <VersionRow key={version.id} version={version} busy={busy} onActivate={onActivate} onReject={onReject} />)}</div>
      </section>
    </section>
  );
}

function VersionRow({ version, busy, onActivate, onReject }: { version: InboxVersionSummary & { parentVersionId?: string | null }; busy: boolean; onActivate: (id: string) => void; onReject: (id: string) => void }) {
  const reviewStatus = labelOf(VERSION_REVIEW_LABELS, version.reviewStatus);
  return (
    <div className={`inbox-version-row${version.isActive ? " is-active" : ""}`}>
      <div>
        <strong>v{version.version} · {labelOf(VERSION_ORIGIN_LABELS, version.origin)}</strong>
        <p>{reviewStatus} · {labelOf(QUALITY_STATUS_LABELS, version.qualityStatus)} · {version.charCount.toLocaleString()}자 · {version.createdAt.slice(0, 16).replace("T", " ")}</p>
      </div>
      <div className="inbox-version-row__actions">
        {version.isActive && <span className="pill">현재 사용</span>}
        {!version.isActive && version.reviewStatus !== "REJECTED" && <button className="ui-button-secondary" disabled={busy} onClick={() => onActivate(version.id)}>이 버전 사용</button>}
        {version.reviewStatus === "PENDING_REVIEW" && <button className="ui-button-secondary" disabled={busy} onClick={() => onReject(version.id)}>보류</button>}
      </div>
    </div>
  );
}

function QualityReport({ detail }: { detail: InboxDetail }) {
  const report = detail.activeVersion?.report;
  if (!report) return <p className="table-note">정규화 리포트가 아직 없습니다.</p>;
  return <dl className="inbox-quality-report">
    <div><dt>추출 문자</dt><dd>{report.extractedChars.toLocaleString()}</dd></div>
    <div><dt>정규화 문자</dt><dd>{report.normalizedChars.toLocaleString()}</dd></div>
    <div><dt>의미 문자</dt><dd>{report.meaningfulChars.toLocaleString()}</dd></div>
    <div><dt>반복 줄 비율</dt><dd>{Math.round(report.repeatedLineRatio * 100)}%</dd></div>
    <div><dt>미해결 첨부</dt><dd>{report.unresolvedEmbedCount}</dd></div>
    <div><dt>경고</dt><dd>{report.warnings.length ? report.warnings.join(", ") : "없음"}</dd></div>
  </dl>;
}
