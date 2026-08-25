import { useMemo, useState } from "react";
import type { VisualAnalysisSummary } from "@radar/shared";

type ObservationKey = keyof DraftPayload["observation"];
type FormalKey = keyof DraftPayload["formal"];
type ContextKey = keyof DraftPayload["context"];

interface DraftPayload {
  observation: {
    subject: string[];
    composition: string[];
    color: string[];
    texture: string[];
    spatialRelation: string[];
    material: string[];
    lighting: string[];
    visibleText: string[];
  };
  formal: {
    shapes: string[];
    lines: string[];
    planes: string[];
    rhythm: string[];
    scale: string[];
    density: string[];
    edges: string[];
    contrast: string[];
    perspective: string[];
  };
  context: {
    medium: string[];
    process: string[];
    relationToPhotography: string[];
    culturalReferences: string[];
  };
  propositions: string[];
  uncertainty: string[];
  visualKind: "PHOTO" | "ARTWORK" | "INSTALLATION" | "GRAPHIC" | "DIAGRAM" | "DOCUMENT_SCAN" | "OTHER";
  confidence: number | null;
}

interface VisualAnalysisEditorProps {
  analysis: VisualAnalysisSummary;
  onCancel: () => void;
  onSave: (payload: DraftPayload) => Promise<void>;
}

const LIMITS: Record<string, number> = {
  subject: 8,
  composition: 8,
  color: 8,
  texture: 8,
  spatialRelation: 8,
  material: 8,
  lighting: 8,
  visibleText: 8,
  shapes: 8,
  lines: 8,
  planes: 8,
  rhythm: 8,
  scale: 8,
  density: 8,
  edges: 8,
  contrast: 8,
  perspective: 8,
  medium: 6,
  process: 6,
  relationToPhotography: 6,
  culturalReferences: 6,
  propositions: 8,
  uncertainty: 8,
};

const OBSERVATION_FIELDS: Array<{ key: ObservationKey; label: string }> = [
  { key: "subject", label: "관찰" },
  { key: "composition", label: "구도" },
  { key: "color", label: "색" },
  { key: "texture", label: "질감" },
  { key: "spatialRelation", label: "공간 관계" },
  { key: "material", label: "재료" },
  { key: "lighting", label: "빛" },
  { key: "visibleText", label: "읽히는 텍스트" },
];

const FORMAL_FIELDS: Array<{ key: FormalKey; label: string }> = [
  { key: "shapes", label: "형태" },
  { key: "lines", label: "선" },
  { key: "planes", label: "면" },
  { key: "rhythm", label: "리듬" },
  { key: "scale", label: "스케일" },
  { key: "density", label: "밀도" },
  { key: "edges", label: "경계" },
  { key: "contrast", label: "대비" },
  { key: "perspective", label: "원근" },
];

const CONTEXT_FIELDS: Array<{ key: ContextKey; label: string }> = [
  { key: "medium", label: "매체" },
  { key: "process", label: "과정" },
  { key: "relationToPhotography", label: "사진과의 관계" },
  { key: "culturalReferences", label: "문화 참조" },
];

function ensureStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function fromAnalysis(analysis: VisualAnalysisSummary): DraftPayload {
  const root = analysis.payload as Partial<DraftPayload>;
  return {
    observation: {
      subject: ensureStringArray(root.observation?.subject),
      composition: ensureStringArray(root.observation?.composition),
      color: ensureStringArray(root.observation?.color),
      texture: ensureStringArray(root.observation?.texture),
      spatialRelation: ensureStringArray(root.observation?.spatialRelation),
      material: ensureStringArray(root.observation?.material),
      lighting: ensureStringArray(root.observation?.lighting),
      visibleText: ensureStringArray(root.observation?.visibleText),
    },
    formal: {
      shapes: ensureStringArray(root.formal?.shapes),
      lines: ensureStringArray(root.formal?.lines),
      planes: ensureStringArray(root.formal?.planes),
      rhythm: ensureStringArray(root.formal?.rhythm),
      scale: ensureStringArray(root.formal?.scale),
      density: ensureStringArray(root.formal?.density),
      edges: ensureStringArray(root.formal?.edges),
      contrast: ensureStringArray(root.formal?.contrast),
      perspective: ensureStringArray(root.formal?.perspective),
    },
    context: {
      medium: ensureStringArray(root.context?.medium),
      process: ensureStringArray(root.context?.process),
      relationToPhotography: ensureStringArray(root.context?.relationToPhotography),
      culturalReferences: ensureStringArray(root.context?.culturalReferences),
    },
    propositions: ensureStringArray(root.propositions),
    uncertainty: ensureStringArray(root.uncertainty),
    visualKind: typeof root.visualKind === "string" ? root.visualKind : "OTHER",
    confidence: typeof root.confidence === "number" ? root.confidence : null,
  };
}

function trimList(values: string[], key: string, maxLength: number): string[] {
  return values
    .map((value) => value.trim().slice(0, maxLength))
    .filter(Boolean)
    .slice(0, LIMITS[key] ?? 8);
}

function validateClientPayload(draft: DraftPayload): DraftPayload | null {
  const next: DraftPayload = {
    observation: {
      subject: trimList(draft.observation.subject, "subject", 320),
      composition: trimList(draft.observation.composition, "composition", 320),
      color: trimList(draft.observation.color, "color", 320),
      texture: trimList(draft.observation.texture, "texture", 320),
      spatialRelation: trimList(draft.observation.spatialRelation, "spatialRelation", 320),
      material: trimList(draft.observation.material, "material", 320),
      lighting: trimList(draft.observation.lighting, "lighting", 320),
      visibleText: trimList(draft.observation.visibleText, "visibleText", 320),
    },
    formal: {
      shapes: trimList(draft.formal.shapes, "shapes", 320),
      lines: trimList(draft.formal.lines, "lines", 320),
      planes: trimList(draft.formal.planes, "planes", 320),
      rhythm: trimList(draft.formal.rhythm, "rhythm", 320),
      scale: trimList(draft.formal.scale, "scale", 320),
      density: trimList(draft.formal.density, "density", 320),
      edges: trimList(draft.formal.edges, "edges", 320),
      contrast: trimList(draft.formal.contrast, "contrast", 320),
      perspective: trimList(draft.formal.perspective, "perspective", 320),
    },
    context: {
      medium: trimList(draft.context.medium, "medium", 320),
      process: trimList(draft.context.process, "process", 320),
      relationToPhotography: trimList(draft.context.relationToPhotography, "relationToPhotography", 320),
      culturalReferences: trimList(draft.context.culturalReferences, "culturalReferences", 320),
    },
    propositions: trimList(draft.propositions, "propositions", 500),
    uncertainty: trimList(draft.uncertainty, "uncertainty", 320),
    visualKind: draft.visualKind,
    confidence: draft.confidence,
  };

  const meaningful = [
    ...Object.values(next.observation),
    ...Object.values(next.formal),
    ...Object.values(next.context),
    next.propositions,
    next.uncertainty,
  ].some((values) => values.length > 0);

  return meaningful ? next : null;
}

function replaceValue(values: string[], index: number, nextValue: string): string[] {
  return values.map((value, current) => (current === index ? nextValue : value));
}

function removeValue(values: string[], index: number): string[] {
  return values.filter((_, current) => current !== index);
}

function appendValue(values: string[]): string[] {
  return values.length >= 8 ? values : values.concat("");
}

export default function VisualAnalysisEditor({ analysis, onCancel, onSave }: VisualAnalysisEditorProps) {
  const [draft, setDraft] = useState<DraftPayload>(() => fromAnalysis(analysis));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveAttempted, setSaveAttempted] = useState(false);

  const saveLabel = saveAttempted && error ? "다시 저장" : "저장";
  const helperText = useMemo(
    () => "짧은 문장 단위로 다듬고, 비어 있는 항목은 지워 두세요.",
    [],
  );

  async function submit() {
    const validated = validateClientPayload(draft);
    if (!validated) {
      setError("관찰, 형식, 맥락, 제안, 불확실성 중 적어도 하나는 남겨야 합니다.");
      setSaveAttempted(true);
      return;
    }
    setSaving(true);
    setError("");
    setSaveAttempted(true);
    try {
      await onSave(validated);
    } catch {
      setError("저장하지 못했습니다. 입력을 유지한 상태로 다시 시도해 주세요.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="visual-analysis-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="visual-analysis-editor__header">
        <div>
          <p className="reading-section__label">사용자 검증 편집</p>
          <h4>분석 수정</h4>
        </div>
        <p>{helperText}</p>
      </div>

      <EditorGroup
        title="관찰"
        fields={OBSERVATION_FIELDS.map((field) => ({
          ...field,
          values: draft.observation[field.key],
          onChange: (index, value) => setDraft((current) => ({
            ...current,
            observation: {
              ...current.observation,
              [field.key]: replaceValue(current.observation[field.key], index, value),
            },
          })),
          onAdd: () => setDraft((current) => ({
            ...current,
            observation: {
              ...current.observation,
              [field.key]: appendValue(current.observation[field.key]),
            },
          })),
          onRemove: (index) => setDraft((current) => ({
            ...current,
            observation: {
              ...current.observation,
              [field.key]: removeValue(current.observation[field.key], index),
            },
          })),
        }))}
      />

      <EditorGroup
        title="형식"
        fields={FORMAL_FIELDS.map((field) => ({
          ...field,
          values: draft.formal[field.key],
          onChange: (index, value) => setDraft((current) => ({
            ...current,
            formal: {
              ...current.formal,
              [field.key]: replaceValue(current.formal[field.key], index, value),
            },
          })),
          onAdd: () => setDraft((current) => ({
            ...current,
            formal: {
              ...current.formal,
              [field.key]: appendValue(current.formal[field.key]),
            },
          })),
          onRemove: (index) => setDraft((current) => ({
            ...current,
            formal: {
              ...current.formal,
              [field.key]: removeValue(current.formal[field.key], index),
            },
          })),
        }))}
      />

      <EditorGroup
        title="맥락"
        fields={CONTEXT_FIELDS.map((field) => ({
          ...field,
          values: draft.context[field.key],
          onChange: (index, value) => setDraft((current) => ({
            ...current,
            context: {
              ...current.context,
              [field.key]: replaceValue(current.context[field.key], index, value),
            },
          })),
          onAdd: () => setDraft((current) => ({
            ...current,
            context: {
              ...current.context,
              [field.key]: appendValue(current.context[field.key]),
            },
          })),
          onRemove: (index) => setDraft((current) => ({
            ...current,
            context: {
              ...current.context,
              [field.key]: removeValue(current.context[field.key], index),
            },
          })),
        }))}
      />

      <SingleFieldGroup
        label="제안"
        values={draft.propositions}
        onChange={(index, value) => setDraft((current) => ({ ...current, propositions: replaceValue(current.propositions, index, value) }))}
        onAdd={() => setDraft((current) => ({ ...current, propositions: appendValue(current.propositions) }))}
        onRemove={(index) => setDraft((current) => ({ ...current, propositions: removeValue(current.propositions, index) }))}
      />

      <SingleFieldGroup
        label="불확실성"
        values={draft.uncertainty}
        onChange={(index, value) => setDraft((current) => ({ ...current, uncertainty: replaceValue(current.uncertainty, index, value) }))}
        onAdd={() => setDraft((current) => ({ ...current, uncertainty: appendValue(current.uncertainty) }))}
        onRemove={(index) => setDraft((current) => ({ ...current, uncertainty: removeValue(current.uncertainty, index) }))}
      />

      {error && <p className="visual-analysis-editor__error" role="alert">{error}</p>}

      <div className="visual-analysis-editor__actions">
        <button type="button" className="ui-button-secondary" onClick={onCancel} disabled={saving}>취소</button>
        <button type="submit" className="ui-button" disabled={saving}>{saving ? "저장 중…" : saveLabel}</button>
      </div>
    </form>
  );
}

interface EditorFieldProps {
  label: string;
  values: string[];
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

function SingleFieldGroup({ label, values, onChange, onAdd, onRemove }: EditorFieldProps) {
  return (
    <section className="visual-analysis-editor__group">
      <div className="visual-analysis-editor__group-heading">
        <h5>{label}</h5>
        <button type="button" className="ui-button-secondary" onClick={onAdd}>항목 추가</button>
      </div>
      {(values.length > 0 ? values : [""]).map((value, index) => (
        <div className="visual-analysis-editor__item" key={`${label}-${index}`}>
          <label>
            <span>{label} {index + 1}</span>
            <input value={value} onChange={(event) => onChange(index, event.target.value)} />
          </label>
          <button type="button" className="ui-button-secondary" onClick={() => onRemove(index)} aria-label={`${label} ${index + 1} 삭제`}>삭제</button>
        </div>
      ))}
    </section>
  );
}

function EditorGroup({ title, fields }: { title: string; fields: Array<EditorFieldProps & { key: string }> }) {
  return (
    <section className="visual-analysis-editor__group">
      <h5>{title}</h5>
      <div className="visual-analysis-editor__matrix">
        {fields.map((field) => (
          <SingleFieldGroup
            key={field.key}
            label={field.label}
            values={field.values}
            onChange={field.onChange}
            onAdd={field.onAdd}
            onRemove={field.onRemove}
          />
        ))}
      </div>
    </section>
  );
}
