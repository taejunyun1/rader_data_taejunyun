import { KEYWORD_LABELS, labelOf } from "../../lib/labels";
import { compositionRows, decisionRows, type RadarStats } from "../../lib/radarPresentation";

function Bar({ percent }: { percent: number }) {
  return <span className="radar-bar" aria-hidden="true"><span style={{ width: `${Math.max(percent, percent ? 6 : 0)}%` }} /></span>;
}

export default function RadarOverview({ stats, periodLabel }: { stats: RadarStats; periodLabel: string }) {
  const keywords = stats.newKeywords.slice(0, 6);
  const keywordMax = Math.max(...keywords.map((item) => item.count), 1);
  const decisions = decisionRows(stats.signalCounts);
  const composition = compositionRows(stats.kindBreakdown);
  const hasDecisions = decisions.some((item) => item.count > 0);

  return <section className="radar-overview" aria-label={`${periodLabel} 정량 요약`}>
    <div className="radar-overview__heading">
      <div><p className="reading-section__label">이번 기간 요약</p><h2>{periodLabel} 연구 상태</h2></div>
      <p>숫자는 선택한 기간 기준이며, 저장소 구성만 전체 누적입니다.</p>
    </div>
    <div className="radar-metrics">
      <div><span>새 자료</span><strong>{stats.newSources}</strong></div>
      <div><span>착즙</span><strong>{stats.distillRuns}</strong></div>
      <div><span>연구 공백</span><strong>{stats.gapsRaised}</strong></div>
      <div><span>읽기 큐</span><strong>{stats.readingQueueSize}</strong></div>
    </div>
    <div className="radar-overview__charts">
      <section><h3>관심 신호</h3><p>이 기간에 새로 자주 등장한 키워드</p>
        {keywords.length ? <ol className="radar-chart-list" aria-label={`${periodLabel} 관심 신호`}>
          {keywords.map((item) => { const translated = labelOf(KEYWORD_LABELS, item.keyword, item.keyword.replaceAll("-", " · ")); return <li key={item.keyword}><div><strong>{translated}</strong><span>{item.count}회</span></div>{translated !== item.keyword && <small>{item.keyword}</small>}<Bar percent={(item.count / keywordMax) * 100} /></li>; })}
        </ol> : <p className="table-note">이 기간에 새롭게 집계된 키워드가 없습니다.</p>}
      </section>
      <section><h3>판단 분포</h3><p>읽은 뒤 남긴 발전·보관·관찰·제외</p>
        {hasDecisions ? <ol className="radar-chart-list" aria-label={`${periodLabel} 판단 분포`}>
          {decisions.map((item) => <li key={item.action}><div><strong>{item.label}</strong><span>{item.count}회 · {item.percent}%</span></div><Bar percent={item.percent} /></li>)}
        </ol> : <p className="table-note">이 기간에 남긴 판단이 없습니다.</p>}
      </section>
      <section><h3>저장소 구성</h3><p>전체 누적 자료 유형</p>
        {composition.length ? <ol className="radar-chart-list" aria-label="저장소 전체 자료 구성">
          {composition.map((item) => <li key={item.kind}><div><strong>{item.label}</strong><span>{item.count}개 · {item.percent}%</span></div><Bar percent={item.percent} /></li>)}
        </ol> : <p className="table-note">저장소에 집계된 자료가 없습니다.</p>}
      </section>
    </div>
  </section>;
}
