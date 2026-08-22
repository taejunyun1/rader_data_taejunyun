interface CounterSectionProps {
  counter: {
    dominant_claim?: string;
    opposing_thesis?: string;
    incompatibility?: string;
    conditions?: string[];
    axes?: { from: string; to: string; rationale: string }[];
    suggestions?: { direction: string; grounding?: { name: string; kind: string; note: string }[] }[];
    validation?: { status: "verified" | "corrected" | "unverified"; issues?: string[] };
  } | null;
  enabled: boolean;
}

export default function CounterSection({ counter, enabled }: CounterSectionProps) {
  if (!enabled) return <section id="counter" className="distill-section distill-section--note"><p className="reading-section__label">정면 반대 관점</p><p className="distill-copy">이번 착즙에서는 반대 관점을 제외했습니다.</p></section>;
  if (!counter) return <section id="counter" className="distill-section distill-section--note"><p className="reading-section__label">정면 반대 관점</p><p className="distill-copy">반대 관점 결과가 없습니다.</p></section>;
  const verified = counter.validation?.status === "verified" || counter.validation?.status === "corrected";
  return <section id="counter" className={`distill-section distill-counter${verified ? "" : " is-unverified"}`}>
    <p className="reading-section__label">정면 반대 관점</p>
    {counter.validation?.status === "unverified" && <p className="distill-warning" role="status">반대 관점을 충분히 검증하지 못했습니다. 아래 내용은 확정 제안으로 사용하지 마세요.</p>}
    {counter.dominant_claim && <div className="counter-contrast"><div><span>현재 중심 주장</span><strong>{counter.dominant_claim}</strong></div><div><span>정반대 명제</span><strong>{counter.opposing_thesis ?? "정반대 명제가 생성되지 않았습니다."}</strong></div></div>}
    {counter.incompatibility && <p className="distill-copy">{counter.incompatibility}</p>}
    {counter.axes?.map((axis) => <article className="counter-axis" key={`${axis.from}-${axis.to}`}><strong>{axis.from} → {axis.to}</strong><p>{axis.rationale}</p></article>)}
    {counter.conditions?.length ? <div className="deep-analysis__group"><p className="reading-section__label">반대 명제가 설득력을 갖는 조건</p>{counter.conditions.map((condition) => <p className="distill-copy" key={condition}>{condition}</p>)}</div> : null}
    {counter.suggestions?.map((suggestion) => <article className="counter-suggestion" key={suggestion.direction}><strong>{suggestion.direction}</strong>{suggestion.grounding?.map((grounding) => <p key={`${grounding.name}-${grounding.note}`}>{grounding.name} · {grounding.note}</p>)}</article>)}
  </section>;
}
