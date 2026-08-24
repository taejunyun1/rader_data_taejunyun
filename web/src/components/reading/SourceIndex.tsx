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
  const activeIndex = Math.max(items.findIndex((item) => item.id === selectedId), 0);

  function moveSelection(index: number) {
    const next = items[index];
    if (!next) return;
    onSelect(next.id);
    buttonRefs.current[next.id]?.focus();
  }

  return (
    <aside className="source-index" aria-label={title}>
      <div className="source-index__header"><h2>{title}</h2><span>{count}개</span></div>
      {items.length === 0 ? <p className="source-index__empty">표시할 자료가 없습니다.</p> : <ul className="source-index__list" aria-label={title}>
        {items.map((item, index) => {
          const selected = item.id === selectedId;
          return (
            <li key={item.id}>
              <button
                ref={(node) => { buttonRefs.current[item.id] = node; }}
                className={`source-index__item${selected ? " is-selected" : ""}`}
                aria-current={selected ? "true" : undefined}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => onSelect(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); moveSelection(Math.min(index + 1, items.length - 1)); }
                  if (event.key === "ArrowUp") { event.preventDefault(); moveSelection(Math.max(index - 1, 0)); }
                  if (event.key === "Home") { event.preventDefault(); moveSelection(0); }
                  if (event.key === "End") { event.preventDefault(); moveSelection(items.length - 1); }
                }}
              >
                <span className="source-index__meta">{item.meta}</span>
                <strong>{item.title}</strong>
                {item.tags.length > 0 && <span className="source-index__tags">{item.tags.slice(0, 3).join(" · ")}</span>}
                {item.access.kind === "UNKNOWN"
                  ? <span className="source-index__access-note">{item.access.label}</span>
                  : <SourceAccessBadge access={item.access} linked={false} />}
              </button>
            </li>
          );
        })}
      </ul>}
    </aside>
  );
}
