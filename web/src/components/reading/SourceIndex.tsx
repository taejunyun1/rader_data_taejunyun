import { useRef } from "react";
import type { SourceIndexItem } from "./types";
import SourceAccessBadge from "./SourceAccessBadge";

interface SourceIndexProps {
  title: string;
  items: SourceIndexItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  count?: number;
}

export default function SourceIndex({ title, items, selectedId, onSelect, count = items.length }: SourceIndexProps) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function moveSelection(index: number) {
    const next = items[index];
    if (!next) return;
    onSelect(next.id);
    buttonRefs.current[next.id]?.focus();
  }

  return (
    <aside className="source-index" aria-label={title}>
      <div className="source-index__header"><h2>{title}</h2><span>{count}개</span></div>
      {items.length === 0 ? <p className="source-index__empty">표시할 자료가 없습니다.</p> : <div className="source-index__list" role="listbox" aria-label={title}>
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => { buttonRefs.current[item.id] = node; }}
            className={`source-index__item${item.id === selectedId ? " is-selected" : ""}`}
            role="option"
            aria-selected={item.id === selectedId}
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(Math.min(index + 1, items.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(Math.max(index - 1, 0)); }
            }}
          >
            <span className="source-index__meta">{item.meta}</span>
            <strong>{item.title}</strong>
            {item.tags.length > 0 && <span className="source-index__tags">{item.tags.slice(0, 3).join(" · ")}</span>}
            <SourceAccessBadge access={item.access} />
          </button>
        ))}
      </div>}
    </aside>
  );
}
