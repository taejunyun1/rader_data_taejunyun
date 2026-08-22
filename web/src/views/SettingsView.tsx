import { useEffect, useMemo, useState } from "react";
import { PRESETS, type AiModelRoles, type PresetName, type RadarParams } from "@radar/shared";
import PageHeader from "../components/layout/PageHeader";
import StatusMessage from "../components/ui/StatusMessage";
import type { ModelOption } from "../lib/modelSettings";

const PARAM_FIELDS: { key: keyof RadarParams; label: string; left: string; right: string }[] = [
  { key: "familiarity", label: "익숙함", left: "새로운 영역", right: "기존 관심사" },
  { key: "researchDepth", label: "연구 깊이", left: "가볍게 탐색", right: "깊이 파고들기" },
  { key: "divergence", label: "발산 정도", left: "응집된 연결", right: "뜻밖의 연결" },
  { key: "counterStrength", label: "반대 관점", left: "부드러운 반론", right: "강한 반대 미학" },
  { key: "technicalPhotographic", label: "기술 ↔ 사진", left: "시스템·기술", right: "이미지·물질" },
];
const PRESET_LABELS: Record<PresetName, string> = { BALANCED: "균형", DEEP_RESEARCH: "깊은 연구", ARTWORK_EXPLORATION: "작업 탐색", COUNTER_HEAVY: "반대 관점 강화", TECHNICAL: "기술 중심" };

interface ModelSettingsResponse {
  roles: AiModelRoles;
  models: ModelOption[];
  error?: string;
}

type TestedRoles = { baseModel: string | null; reviewModel: string | null };

export default function SettingsView() {
  const [params, setParams] = useState<RadarParams | null>(null);
  const [msg, setMsg] = useState("");
  const [exportMsg, setExportMsg] = useState("");
  const [homepageMsg, setHomepageMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelSettings, setModelSettings] = useState<ModelSettingsResponse | null>(null);
  const [modelDraft, setModelDraft] = useState<AiModelRoles | null>(null);
  const [tested, setTested] = useState<TestedRoles>({ baseModel: null, reviewModel: null });
  const [modelMsg, setModelMsg] = useState("");
  const [modelBusy, setModelBusy] = useState(false);

  useEffect(() => {
    fetch("/api/settings/params").then((response) => response.json() as Promise<RadarParams>).then(setParams).catch(() => setParams(null));
    void loadModelSettings();
  }, []);

  async function loadModelSettings() {
    try {
      const response = await fetch("/api/settings/models");
      const data = await response.json() as ModelSettingsResponse;
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setModelSettings(data);
      setModelDraft(data.roles);
      setTested({ baseModel: null, reviewModel: null });
    } catch (error) {
      setModelMsg(`모델 목록을 불러오지 못했습니다: ${(error as Error).message}`);
    }
  }

  async function save(next: RadarParams) {
    setParams(next); setBusy(true);
    try {
      const response = await fetch("/api/settings/params", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      setMsg(response.ok ? "연구 성향을 저장했습니다." : `저장하지 못했습니다: ${response.status}`);
    } catch (error) { setMsg(`저장하지 못했습니다: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function testModels() {
    if (!modelDraft) return;
    setModelBusy(true); setModelMsg("두 모델의 연결을 확인하는 중입니다…");
    const ids = [...new Set([modelDraft.baseModel, modelDraft.reviewModel])];
    const results = await Promise.all(ids.map(async (modelId) => {
      try {
        const response = await fetch("/api/settings/models/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ modelId }) });
        const data = await response.json() as { ok?: boolean; error?: string };
        return { modelId, ok: response.ok && data.ok === true, error: data.error };
      } catch (error) { return { modelId, ok: false, error: (error as Error).message }; }
    }));
    const failed = results.find((result) => !result.ok);
    setTested({
      baseModel: results.find((result) => result.modelId === modelDraft.baseModel)?.ok ? modelDraft.baseModel : null,
      reviewModel: results.find((result) => result.modelId === modelDraft.reviewModel)?.ok ? modelDraft.reviewModel : null,
    });
    setModelMsg(failed ? `연결 확인 실패: ${failed.modelId} · ${failed.error ?? "호환되지 않는 모델"}` : "두 모델의 연결을 확인했습니다. 이제 저장할 수 있습니다.");
    setModelBusy(false);
  }

  async function saveModels() {
    if (!modelDraft || tested.baseModel !== modelDraft.baseModel || tested.reviewModel !== modelDraft.reviewModel) {
      setModelMsg("먼저 두 모델의 연결을 확인하세요.");
      return;
    }
    setModelBusy(true);
    try {
      const response = await fetch("/api/settings/models", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modelDraft) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setModelSettings((current) => current ? { ...current, roles: modelDraft } : current);
      setModelMsg("AI 모델 역할 설정을 저장했습니다. 이후 작업부터 적용됩니다.");
    } catch (error) { setModelMsg(`모델 설정을 저장하지 못했습니다: ${(error as Error).message}`); }
    finally { setModelBusy(false); }
  }

  async function action(path: string, setter: (message: string) => void, success: (data: Record<string, unknown>) => string) {
    setBusy(true);
    try {
      const response = await fetch(path, { method: "POST" }); const data = await response.json() as Record<string, unknown>;
      setter(response.ok ? success(data) : `작업을 완료하지 못했습니다: ${response.status}`);
    } catch (error) { setter(`연결하지 못했습니다: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  const selectedOptions = useMemo(() => new Map((modelSettings?.models ?? []).map((model) => [model.id, model])), [modelSettings?.models]);
  const unknownPricing = modelDraft ? [modelDraft.baseModel, modelDraft.reviewModel].some((id) => !selectedOptions.get(id)?.pricingKnown) : false;

  return <div className="view-stack"><PageHeader title="설정" description="발견과 착즙이 자료를 읽는 방식에 맞게 작동하도록 조정합니다." />
    <section className="settings-section"><h2>연구 성향</h2><p>이 값은 발견 후보의 방향과 착즙의 균형에 반영됩니다.</p>{params ? <>{PARAM_FIELDS.map((field) => <label className="settings-range" key={field.key}><span className="settings-range__heading"><span>{field.label}</span><span>{params[field.key].toFixed(2)}</span></span><input type="range" min={0} max={1} step={0.05} value={params[field.key]} disabled={busy} onChange={(event) => setParams({ ...params, [field.key]: Number(event.target.value) })} onMouseUp={() => void save(params)} onTouchEnd={() => void save(params)} /><span className="settings-range__ends"><span>{field.left}</span><span>{field.right}</span></span></label>)}{msg && <p className="reservoir-message" role="status">{msg}</p>}</> : <StatusMessage kind="loading" title="연구 성향을 불러오는 중입니다" />}</section>
    <section className="settings-section"><h2>AI 모델 역할</h2><p>자료마다 모델을 고르지 않고, 전체 소화 과정에서 사용할 두 역할을 지정합니다.</p>{modelDraft && modelSettings ? <><div className="settings-model-grid"><label className="settings-model-card"><span>기본 모델</span><small>청크 읽기·초벌 정리·일반 반론</small><select aria-label="기본 모델" value={modelDraft.baseModel} disabled={modelBusy} onChange={(event) => { setModelDraft({ ...modelDraft, baseModel: event.target.value }); setTested((current) => ({ ...current, baseModel: null })); }}>{modelSettings.models.map((model) => <option key={model.id} value={model.id}>{model.id}{model.pricingKnown ? "" : " · 가격 미등록"}</option>)}</select></label><label className="settings-model-card"><span>상위 통합·반론 검증 모델</span><small>최종 통합·중요 자료·반론 정합성 검증</small><select aria-label="상위 통합·반론 검증 모델" value={modelDraft.reviewModel} disabled={modelBusy} onChange={(event) => { setModelDraft({ ...modelDraft, reviewModel: event.target.value }); setTested((current) => ({ ...current, reviewModel: null })); }}>{modelSettings.models.map((model) => <option key={model.id} value={model.id}>{model.id}{model.pricingKnown ? "" : " · 가격 미등록"}</option>)}</select></label></div>{unknownPricing && <p className="settings-warning" role="status">가격이 등록되지 않은 모델이 포함되어 있어 비용은 보수적 상한으로 계산됩니다.</p>}<div className="settings-actions"><button className="ui-button-secondary" disabled={modelBusy} onClick={() => void loadModelSettings()}>모델 목록 새로고침</button><button className="ui-button-secondary" disabled={modelBusy} onClick={() => void testModels()}>연결 확인</button><button className="ui-button" disabled={modelBusy || tested.baseModel !== modelDraft.baseModel || tested.reviewModel !== modelDraft.reviewModel} onClick={() => void saveModels()}>모델 설정 저장</button></div>{modelMsg && <p className="reservoir-message" role="status">{modelMsg}</p>}</> : <StatusMessage kind="loading" title="사용 가능한 모델을 불러오는 중입니다" description={modelMsg || undefined} />}</section>
    <section className="settings-section"><h2>빠른 프리셋</h2><p>자주 쓰는 읽기 모드를 바로 적용합니다.</p><div className="settings-actions">{(Object.keys(PRESETS) as PresetName[]).map((preset) => <button key={preset} className="filter-button" disabled={busy} onClick={() => void save(PRESETS[preset])}>{PRESET_LABELS[preset]}</button>)}</div></section>
    <section className="settings-section"><h2>홈페이지 연결</h2><p>taejunyun.com의 프로젝트 정보를 발견 맥락에 반영합니다. 원본 데이터는 별도로 보존됩니다.</p><button className="ui-button-secondary" disabled={busy} onClick={() => void action("/api/settings/import-homepage", setHomepageMsg, (data) => `프로젝트 ${data.imported ?? 0}개를 가져왔습니다. 중복 ${data.duplicates ?? 0}개.`)}>홈페이지 프로젝트 다시 가져오기</button>{homepageMsg && <p className="reservoir-message" role="status">{homepageMsg}</p>}</section>
    <section className="settings-section"><h2>데이터 내보내기</h2><p>원본과 분석 결과를 필요한 형식으로 내려받습니다.</p><div className="settings-actions"><a className="ui-button-secondary" href="/api/export/json" download>전체 JSON</a><a className="ui-button-secondary" href="/api/export/markdown" download>마크다운</a><a className="ui-button-secondary" href="/api/export/csv" download>자료 CSV</a><button className="ui-button-secondary" disabled={busy} onClick={() => void action("/api/export/originals-to-r2", setExportMsg, (data) => `원본 ${data.copied ?? 0}/${data.total ?? 0}개를 백업했습니다.`)}>원본 R2 백업</button></div>{exportMsg && <p className="reservoir-message" role="status">{exportMsg}</p>}</section>
    <section className="settings-section"><h2>고급 관리</h2><p>운영 중 데이터 품질을 보정할 때만 실행하세요. 작업 결과는 되돌리기 어렵습니다.</p><div className="settings-actions"><button className="ui-button-secondary" disabled={busy} onClick={() => void action("/api/search/embed-backfill?limit=25", setExportMsg, (data) => `자료 ${data.embedded ?? 0}개를 의미 색인했습니다. 남은 자료 ${data.remaining ?? 0}개.`)}>의미 색인 채우기</button><button className="ui-button-secondary" disabled={busy} onClick={() => void action("/api/reservoir/retag-all", setExportMsg, (data) => `자료 ${data.retagged ?? 0}개의 주제를 다시 분류했습니다.`)}>주제 다시 분류</button></div></section>
  </div>;
}
