import SourceAccessBadge from "./SourceAccessBadge";
import ProvenanceNotice from "./ProvenanceNotice";
import type { ReadingDocument } from "./types";

export default function ReadingPane({ document }: { document: ReadingDocument }) {
  return (
    <article className="reading-pane" aria-labelledby="reading-pane-title">
      <header className="reading-pane__header">
        <p className="reading-pane__kicker">현재 자료</p>
        <h2 id="reading-pane-title">{document.title}</h2>
        {document.originalTitle && document.originalTitle !== document.title && <p className="reading-pane__original-title"><span>원문 제목</span>{document.originalTitle}</p>}
        <p className="reading-pane__byline">{document.byline || "저자·출처 정보 없음"}</p>
        <div className="reading-pane__source"><SourceAccessBadge access={document.access} /></div>
      </header>
      <ProvenanceNotice>{document.provenance}</ProvenanceNotice>
      <div className="reading-pane__body">
        <section className="reading-section">
          <p className="reading-section__label">시스템 해석</p>
          {document.summary ? <p className="reading-section__summary">{document.summary}</p> : <p className="reading-section__empty"><strong>분석 내용 없음</strong><span>원문을 읽고 직접 판단해 주세요.</span></p>}
        </section>
        {document.fragments.length > 0 && <section className="reading-section"><p className="reading-section__label">원문에서 추출한 문장</p>{document.fragments.map((fragment, index) => <blockquote key={`${fragment}-${index}`}>{fragment}</blockquote>)}</section>}
        {document.questions.length > 0 && <section className="reading-section"><p className="reading-section__label">읽으며 붙잡을 질문</p>{document.questions.map((question, index) => <p className="reading-question" key={`${question}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{question}</p>)}</section>}
        {document.keywords.length > 0 && <section className="reading-section"><p className="reading-section__label">연결된 키워드</p><div className="reading-keywords">{document.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></section>}
      </div>
    </article>
  );
}
