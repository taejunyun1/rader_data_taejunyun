import type { SourceAccess } from "../../lib/sourceAccess";
import type { SourceAcquisitionView } from "./types";

export default function SourceAccessBadge({ access, linked = true }: { access: SourceAccess; linked?: boolean }) {
  const content = <><span className="source-access-badge__dot" aria-hidden="true" />{access.label}</>;
  const className = `source-access-badge source-access-badge--${access.kind.toLowerCase()}`;
  if (!linked || !access.href) return <span className={className}>{content}</span>;
  return <a className={className} href={access.href} target="_blank" rel="noreferrer">{content}<span aria-hidden="true"> ↗</span></a>;
}

export function SourceAcquisitionBadge({ acquisition }: { acquisition: SourceAcquisitionView }) {
  return (
    <span
      className={`source-acquisition-badge source-acquisition-badge--${acquisition.textScope.toLowerCase()}`}
      title={acquisition.acquisitionError ?? undefined}
    >
      <span className="source-access-badge__dot" aria-hidden="true" />
      {acquisition.acquisitionLabel}
    </span>
  );
}
