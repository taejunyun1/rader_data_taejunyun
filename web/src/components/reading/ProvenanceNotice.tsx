export default function ProvenanceNotice({ children }: { children: string }) {
  return <aside className="provenance-notice"><strong>출처 구분</strong><span>{children}</span></aside>;
}
