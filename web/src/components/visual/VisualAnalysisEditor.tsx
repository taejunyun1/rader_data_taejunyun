import { useMemo, useState } from "react";
import {
  VISUAL_ANALYSIS_ARRAY_LIMITS,
  type VisualAnalysisPayload,
  type VisualAnalysisSummary,
} from "@radar/shared";

type ObservationKey = keyof DraftPayload["observation"];
type FormalKey = keyof DraftPayload["formal"];
type ContextKey = keyof DraftPayload["context"];

type DraftPayload = VisualAnalysisPayload;

interface VisualAnalysisEditorProps {
  analysis: VisualAnalysisSummary;
  onCancel: () => void;
  onSave: (payload: DraftPayload) => Promise<void>;
}

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

const EDITOR_ITEM_LENGTHS = {
  observation: 320,
  formal: 320,
  context: 320,
  propositions: 500,
  uncertainty: 320,
} as const;

function fromAnalysis(analysis: VisualAnalysisSummary): DraftPayload {
  const fallback = emptyDraft();
  const payload = analysis.payload as Record<string, unknown>;
  const observation = recordValue(payload.observation);
  const formal = recordValue(payload.formal);
  const context = recordValue(payload.context);
  return {
    ...fallback,
    ...payload,
    observation: {
      subject: preserveItems(observation.subject),
      composition: preserveItems(observation.composition),
      color: preserveItems(observation.color),
      texture: preserveItems(observation.texture),
      spatialRelation: preserveItems(observation.spatialRelation),
      material: preserveItems(observation.material),
      lighting: preserveItems(observation.lighting),
      visibleText: preserveItems(observation.visibleText),
    },
    formal: {
      shapes: preserveItems(formal.shapes),
      lines: preserveItems(formal.lines),
      planes: preserveItems(formal.planes),
      rhythm: preserveItems(formal.rhythm),
      scale: preserveItems(formal.scale),
      density: preserveItems(formal.density),
      edges: preserveItems(formal.edges),
      contrast: preserveItems(formal.contrast),
      perspective: preserveItems(formal.perspective),
    },
    context: {
      medium: preserveItems(context.medium),
      process: preserveItems(context.process),
      relationToPhotography: preserveItems(context.relationToPhotography),
      culturalReferences: preserveItems(context.culturalReferences),
    },
    propositions: preserveItems(payload.propositions),
    uncertainty: preserveItems(payload.uncertainty),
  } as DraftPayload;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function preserveItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function emptyDraft(): DraftPayload {
  return {
    observation: {
      subject: [], composition: [], color: [], texture: [], spatialRelation: [], material: [], lighting: [], visibleText: [],
    },
    formal: {
      shapes: [], lines: [], planes: [], rhythm: [], scale: [], density: [], edges: [], contrast: [], perspective: [],
    },
    context: {
      medium: [], process: [], relationToPhotography: [], culturalReferences: [],
    },
    propositions: [],
    uncertainty: [],
    visualKind: "OTHER",
    confidence: null,
  };
}

function replaceValue(values: string[], index: number, nextValue: string): string[] {
  return values.map((value, current) => (current === index ? nextValue : value));
}

function removeValue(values: string[], index: number): string[] {
  return values.filter((_, current) => current !== index);
}

function appendValue(values: string[], maxItems: number): string[] {
  return values.length >= maxItems ? values : values.concat("");
}

interface FieldErrors {
  count: string | null;
  items: Record<number, string>;
}

interface DraftErrors {
  fields: Record<string, FieldErrors>;
  form: string | null;
  hasErrors: boolean;
}

function fieldErrors(fields: Record<string, FieldErrors>, key: string): FieldErrors {
  return fields[key] ?? { count: null, items: {} };
}

function validateField(label: string, values: string[], maxItems: number, maxLength: number): FieldErrors {
  const items: Record<number, string> = {};
  values.forEach((value, index) => {
    if (value.length > maxLength) items[index] = `${label} ${index + 1}은 ${maxLength}자 이내로 입력해 주세요.`;
  });
  return {
    count: values.length > maxItems ? `${label} 항목은 최대 ${maxItems}개까지 입력할 수 있습니다.` : null,
    items,
  };
}

function validateEditorDraft(draft: DraftPayload): DraftErrors {
  const fields: Record<string, FieldErrors> = {};
  const addField = (key: string, label: string, values: string[], maxItems: number, maxLength: number) => {
    fields[key] = validateField(label, values, maxItems, maxLength);
  };

  OBSERVATION_FIELDS.forEach((field) => addField(
    field.key,
    field.label,
    draft.observation[field.key],
    VISUAL_ANALYSIS_ARRAY_LIMITS[field.key],
    EDITOR_ITEM_LENGTHS.observation,
  ));
  FORMAL_FIELDS.forEach((field) => addField(
    field.key,
    field.label,
    draft.formal[field.key],
    VISUAL_ANALYSIS_ARRAY_LIMITS[field.key],
    EDITOR_ITEM_LENGTHS.formal,
  ));
  CONTEXT_FIELDS.forEach((field) => addField(
    field.key,
    field.label,
    draft.context[field.key],
    VISUAL_ANALYSIS_ARRAY_LIMITS[field.key],
    EDITOR_ITEM_LENGTHS.context,
  ));
  addField("propositions", "제안", draft.propositions, VISUAL_ANALYSIS_ARRAY_LIMITS.propositions, EDITOR_ITEM_LENGTHS.propositions);
  addField("uncertainty", "불확실성", draft.uncertainty, VISUAL_ANALYSIS_ARRAY_LIMITS.uncertainty, EDITOR_ITEM_LENGTHS.uncertainty);

  const meaningful = [
    ...Object.values(draft.observation),
    ...Object.values(draft.formal),
    ...Object.values(draft.context),
    draft.propositions,
    draft.uncertainty,
  ].some((values) => values.some((value) => value.trim().length > 0));
  const hasFieldErrors = Object.values(fields).some((field) => field.count !== null || Object.keys(field.items).length > 0);
  return {
    fields,
    form: meaningful ? null : "관찰, 형식, 맥락, 제안, 불확실성 중 적어도 하나는 남겨야 합니다.",
    hasErrors: hasFieldErrors || !meaningful,
  };
}

export default function VisualAnalysisEditor({ analysis, onCancel, onSave }: VisualAnalysisEditorProps) {
  const [draft, setDraft] = useState<DraftPayload>(() => fromAnalysis(analysis));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveAttempted, setSaveAttempted] = useState(false);

  const saveLabel = saveAttempted && error ? "다시 저장" : "저장";
  const validation = validateEditorDraft(draft);
  const helperText = useMemo(
    () => "짧은 문장 단위로 다듬고, 비어 있는 항목은 지워 두세요.",
    [],
  );

  async function submit() {
    const currentValidation = validateEditorDraft(draft);
    if (currentValidation.hasErrors) {
      setError("입력 오류를 해결한 뒤 저장해 주세요.");
      setSaveAttempted(true);
      return;
    }
    setSaving(true);
    setError("");
    setSaveAttempted(true);
    try {
      await onSave(draft);
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
          maxItems: VISUAL_ANALYSIS_ARRAY_LIMITS[field.key],
          maxLength: EDITOR_ITEM_LENGTHS.observation,
          errors: fieldErrors(validation.fields, field.key),
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
              [field.key]: appendValue(current.observation[field.key], VISUAL_ANALYSIS_ARRAY_LIMITS[field.key]),
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
          maxItems: VISUAL_ANALYSIS_ARRAY_LIMITS[field.key],
          maxLength: EDITOR_ITEM_LENGTHS.formal,
          errors: fieldErrors(validation.fields, field.key),
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
              [field.key]: appendValue(current.formal[field.key], VISUAL_ANALYSIS_ARRAY_LIMITS[field.key]),
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
          maxItems: VISUAL_ANALYSIS_ARRAY_LIMITS[field.key],
          maxLength: EDITOR_ITEM_LENGTHS.context,
          errors: fieldErrors(validation.fields, field.key),
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
              [field.key]: appendValue(current.context[field.key], VISUAL_ANALYSIS_ARRAY_LIMITS[field.key]),
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
        maxItems={VISUAL_ANALYSIS_ARRAY_LIMITS.propositions}
        maxLength={EDITOR_ITEM_LENGTHS.propositions}
        errors={fieldErrors(validation.fields, "propositions")}
        values={draft.propositions}
        onChange={(index, value) => setDraft((current) => ({ ...current, propositions: replaceValue(current.propositions, index, value) }))}
        onAdd={() => setDraft((current) => ({ ...current, propositions: appendValue(current.propositions, VISUAL_ANALYSIS_ARRAY_LIMITS.propositions) }))}
        onRemove={(index) => setDraft((current) => ({ ...current, propositions: removeValue(current.propositions, index) }))}
      />

      <SingleFieldGroup
        label="불확실성"
        maxItems={VISUAL_ANALYSIS_ARRAY_LIMITS.uncertainty}
        maxLength={EDITOR_ITEM_LENGTHS.uncertainty}
        errors={fieldErrors(validation.fields, "uncertainty")}
        values={draft.uncertainty}
        onChange={(index, value) => setDraft((current) => ({ ...current, uncertainty: replaceValue(current.uncertainty, index, value) }))}
        onAdd={() => setDraft((current) => ({ ...current, uncertainty: appendValue(current.uncertainty, VISUAL_ANALYSIS_ARRAY_LIMITS.uncertainty) }))}
        onRemove={(index) => setDraft((current) => ({ ...current, uncertainty: removeValue(current.uncertainty, index) }))}
      />

      {validation.form && <p className="visual-analysis-editor__error" role="alert">{validation.form}</p>}
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
  maxItems: number;
  maxLength: number;
  errors: FieldErrors;
  values: string[];
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

function SingleFieldGroup({ label, maxItems, maxLength, errors, values, onChange, onAdd, onRemove }: EditorFieldProps) {
  return (
    <section className="visual-analysis-editor__group">
      <div className="visual-analysis-editor__group-heading">
        <h5>{label}</h5>
        <button type="button" className="ui-button-secondary" onClick={onAdd} disabled={values.length >= maxItems}>항목 추가</button>
      </div>
      {errors.count && <p className="visual-analysis-editor__error" role="alert">{errors.count}</p>}
      {(values.length > 0 ? values : [""]).map((value, index) => (
        <div className="visual-analysis-editor__item" key={`${label}-${index}`}>
          <label>
            <span>{label} {index + 1}</span>
            <input
              value={value}
              maxLength={maxLength}
              aria-invalid={Boolean(errors.items[index])}
              onChange={(event) => onChange(index, event.target.value)}
            />
          </label>
          {errors.items[index] && <p className="visual-analysis-editor__error" role="alert">{errors.items[index]}</p>}
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
            maxItems={field.maxItems}
            maxLength={field.maxLength}
            errors={field.errors}
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
