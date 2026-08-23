export default function ProvenanceNotice({ children, acquisition }: { children: string; acquisition?: string }) {
  return (
    <aside className="provenance-notice">
      <strong>출처 구분</strong>
      <span>{children}</span>
      {acquisition ? <span>{acquisition}</span> : null}
    </aside>
  );
}
