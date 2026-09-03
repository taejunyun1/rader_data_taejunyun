export interface DistillDetailSourceRef {
  id: string;
  title: string;
  available: boolean;
}

interface DistillDetailContentProps {
  fields: Array<{ label: string; value: string }>;
  sourceIds: string[];
  sourceRefs: DistillDetailSourceRef[];
  onOpenReservoir?: (sourceId: string) => void;
}

export default function DistillDetailContent({ fields, sourceIds, sourceRefs, onOpenReservoir }: DistillDetailContentProps) {
  const refsById = new Map(sourceRefs.map((source) => [source.id, source]));
  return <div className="distill-detail-content">
    <dl className="distill-detail-content__fields">
      {fields.map((field) => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
    </dl>
    {sourceIds.length > 0 && <div className="distill-detail-content__sources">
      <p>출처</p>
      <ul>
        {sourceIds.map((sourceId) => {
          const source = refsById.get(sourceId) ?? { id: sourceId, title: sourceId, available: false };
          return <li key={source.id}>
            {source.available && onOpenReservoir
              ? <button type="button" onClick={() => onOpenReservoir(source.id)}>{source.title}</button>
              : <span>{source.title} (현재 저장소에서 찾을 수 없음)</span>}
          </li>;
        })}
      </ul>
    </div>}
  </div>;
}
