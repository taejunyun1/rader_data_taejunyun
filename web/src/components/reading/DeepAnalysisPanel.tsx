export interface DeepAnalysisViewModel {
  profile: "precision" | "maximum";
  overview: string;
  arguments: { claim: string; evidence: string[] }[];
  structure: string[];
  quotes: string[];
  connections: string[];
  researchUses: string[];
  limitations: string[];
  meta: { sourceCharCount: number; analyzedCharCount: number; chunkCount: number };
}

const PROFILE_LABELS = { precision: "정밀", maximum: "최고 정밀" } as const;

export default function DeepAnalysisPanel({ analysis, history, onOpenHistory }: { analysis: DeepAnalysisViewModel | null; history: { id: string; createdAt: string; costUsd?: number }[]; onOpenHistory?: (id: string) => void }) {
  if (!analysis) return <section className="reading-section deep-analysis-empty"><p className="reading-section__label">심층 정리</p><p className="reading-section__empty"><strong>아직 심층 정리 결과가 없습니다.</strong><span>자료를 더 길게 읽고 다시 구조화하려면 위의 버튼을 사용하세요.</span></p></section>;

  return <section className="reading-section deep-analysis" aria-labelledby="deep-analysis-title">
    <div className="reading-section__heading"><div><p className="reading-section__label">심층 정리</p><h3 id="deep-analysis-title">{PROFILE_LABELS[analysis.profile]} 읽기</h3></div><p className="deep-analysis__meta">{analysis.meta.analyzedCharCount.toLocaleString()}자 / {analysis.meta.sourceCharCount.toLocaleString()}자 · {analysis.meta.chunkCount}개 구간</p></div>
    <p className="reading-section__summary">{analysis.overview}</p>
    {analysis.arguments.length > 0 && <div className="deep-analysis__group"><p className="reading-section__label">핵심 주장과 근거</p>{analysis.arguments.map((item) => <article className="deep-analysis__argument" key={item.claim}><strong>{item.claim}</strong>{item.evidence.map((evidence) => <p key={evidence}>{evidence}</p>)}</article>)}</div>}
    {analysis.structure.length > 0 && <div className="deep-analysis__group"><p className="reading-section__label">글의 구조</p><ol>{analysis.structure.map((item) => <li key={item}>{item}</li>)}</ol></div>}
    {analysis.quotes.length > 0 && <div className="deep-analysis__group"><p className="reading-section__label">중요한 원문 문장</p>{analysis.quotes.map((quote) => <blockquote key={quote}>{quote}</blockquote>)}</div>}
    {analysis.connections.length > 0 && <div className="deep-analysis__group"><p className="reading-section__label">연결할 지점</p>{analysis.connections.map((item) => <p className="distill-copy" key={item}>{item}</p>)}</div>}
    {analysis.researchUses.length > 0 && <div className="deep-analysis__group"><p className="reading-section__label">연구에서 다시 쓸 지점</p>{analysis.researchUses.map((item) => <p className="distill-copy" key={item}>{item}</p>)}</div>}
    {analysis.limitations.length > 0 && <div className="deep-analysis__group"><p className="reading-section__label">의문점과 한계</p>{analysis.limitations.map((item) => <p className="distill-copy" key={item}>{item}</p>)}</div>}
    {history.length > 0 && <details className="deep-analysis__history"><summary>이전 심층 정리 {history.length}개</summary><div>{history.map((item) => <button type="button" key={item.id} onClick={() => onOpenHistory?.(item.id)}>{item.createdAt.slice(0, 16).replace("T", " ")} · 이전 정리</button>)}</div></details>}
  </section>;
}
