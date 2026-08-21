import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  controls?: ReactNode;
  primaryAction?: ReactNode;
}

export default function PageHeader({ title, description, controls, primaryAction }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__title"><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {controls && <div className="page-header__controls">{controls}</div>}
      {primaryAction && <div className="page-header__action">{primaryAction}</div>}
    </header>
  );
}
