import { useMemo, useState } from "react";
import type { DiscoveryKeywordRecommendation, DiscoveryLane, DiscoveryProfile } from "@radar/shared/discovery";

interface Props {
  profile: DiscoveryProfile;
  recommendations: { original: DiscoveryKeywordRecommendation[]; counter: DiscoveryKeywordRecommendation[] };
  dirty: boolean;
  onChange: (profile: DiscoveryProfile) => void;
  onSave: () => void;
}

const laneCopy: Record<DiscoveryLane, { title: string; description: string }> = {
  ORIGINAL: { title: "오리지널 방향", description: "지금의 연구 방향을 더 깊고 넓게 찾습니다." },
  COUNTER: { title: "카운터 방향", description: "현재 관점과 반대되는 계보와 자료를 찾습니다." },
};

function strengthLabel(strength: number): string {
  if (strength === 0) return "꺼짐";
  if (strength < 40) return "가볍게";
  if (strength < 70) return "표준";
  return "깊게";
}

export default function DiscoveryDirectionPanel({ profile, recommendations, dirty, onChange, onSave }: Props) {
  const [draft, setDraft] = useState("");
  const [draftLane, setDraftLane] = useState<DiscoveryLane>("ORIGINAL");
  const lanes: DiscoveryLane[] = ["ORIGINAL", "COUNTER"];

  const updateLane = (lane: DiscoveryLane, patch: Partial<DiscoveryProfile["original"]>) => {
    onChange({ ...profile, [lane === "ORIGINAL" ? "original" : "counter"]: { ...profile[lane === "ORIGINAL" ? "original" : "counter"], ...patch } });
  };

  const addKeyword = (lane: DiscoveryLane, keyword: string) => {
    const value = keyword.trim();
    if (!value) return;
    const key = lane === "ORIGINAL" ? "original" : "counter";
    if (profile[key].keywords.length >= 4 || profile[key].keywords.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    updateLane(lane, { keywords: [...profile[key].keywords, value].slice(0, 4) });
  };

  const suggestion = useMemo(() => recommendations[draftLane === "ORIGINAL" ? "original" : "counter"].filter((item) => !item.selected).slice(0, 8), [draftLane, recommendations]);

  return (
    <section className="discovery-direction-panel" aria-labelledby="discovery-direction-title">
      <div className="discovery-direction-panel__heading">
        <div><p className="reading-section__label">탐색 방향</p><h2 id="discovery-direction-title">어느 쪽을 더 깊게 볼까요?</h2></div>
        <span className="table-note">저장 키워드와 강도는 다음 발견 실행에 적용됩니다.</span>
      </div>
      <div className="discovery-direction-panel__grid">
        {lanes.map((lane) => {
          const key = lane === "ORIGINAL" ? "original" : "counter";
          const laneRecommendations = recommendations[key];
          return (
            <section className={`discovery-direction-card discovery-direction-card--${lane.toLowerCase()}`} key={lane} aria-label={laneCopy[lane].title}>
              <div className="discovery-direction-card__title"><div><h3>{laneCopy[lane].title}</h3><p>{laneCopy[lane].description}</p></div><strong>{profile[key].strength} · {strengthLabel(profile[key].strength)}</strong></div>
              <label className="discovery-strength"><span>탐색 강도</span><input aria-label={`${laneCopy[lane].title} 탐색 강도`} type="range" min="0" max="100" step="10" value={profile[key].strength} onChange={(event) => updateLane(lane, { strength: Number(event.target.value) })} /></label>
              <div className="discovery-keywords" aria-label={`${laneCopy[lane].title} 저장 키워드`}>
                {profile[key].keywords.map((keyword) => <button type="button" className="keyword-chip keyword-chip--selected" key={keyword} onClick={() => updateLane(lane, { keywords: profile[key].keywords.filter((item) => item !== keyword) })}>{keyword} ×</button>)}
                {profile[key].keywords.length === 0 && <span className="table-note">저장된 키워드 없음</span>}
              </div>
              <div className="discovery-keyword-input"><input aria-label={`${laneCopy[lane].title} 키워드 입력`} value={draftLane === lane ? draft : ""} disabled={profile[key].keywords.length >= 4} placeholder={profile[key].keywords.length >= 4 ? "최대 4개" : "키워드 추가"} onFocus={() => setDraftLane(lane)} onChange={(event) => { setDraftLane(lane); setDraft(event.target.value); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addKeyword(lane, draft); setDraft(""); } }} /><button type="button" className="ui-button-secondary" disabled={profile[key].keywords.length >= 4 || !draft.trim()} onClick={() => { addKeyword(lane, draft); setDraft(""); }}>추가</button></div>
              <div className="discovery-recommendations"><span>추천</span>{laneRecommendations.slice(0, 4).map((item) => <button type="button" className="keyword-chip" title={item.reason} key={`${item.source}-${item.keyword}`} onClick={() => addKeyword(lane, item.keyword)}>{item.keyword}</button>)}{laneRecommendations.length === 0 && <small>새 추천이 아직 없습니다.</small>}</div>
            </section>
          );
        })}
      </div>
      <div className="discovery-direction-panel__footer"><span className="table-note">{dirty ? "저장하지 않은 변경이 있습니다." : "현재 설정이 저장되어 있습니다."}</span><button className="ui-button" type="button" disabled={!dirty} onClick={onSave}>검색 설정 저장</button></div>
    </section>
  );
}
