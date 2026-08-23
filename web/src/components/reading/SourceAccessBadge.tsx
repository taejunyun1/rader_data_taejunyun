import type { SourceAccess } from "../../lib/sourceAccess";
import type { SourceAcquisitionView } from "./types";

export default function SourceAccessBadge({ access }: { access: SourceAccess }) {
  const content = <><span className="source-access-badge__dot" aria-hidden="true" />{access.label}</>;
  if (!access.href) return <span className={`source-access-badge source-access-badge--${access.kind.toLowerCase()}`}>{content}</span>;
  return <a className={`source-access-badge source-access-badge--${access.kind.toLowerCase()}`} href={access.href} target="_blank" rel="noreferrer">{content}<span aria-hidden="true"> ↗</span></a>;
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
