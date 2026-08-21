interface DocumentOutlineProps { sections: { id: string; label: string; count?: number }[]; }

export default function DocumentOutline({ sections }: DocumentOutlineProps) {
  return <nav className="document-outline" aria-label="착즙 문서 목차"><p>이 문서에서</p>{sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.label}{section.count != null && <span>{section.count}</span>}</a>)}</nav>;
}
