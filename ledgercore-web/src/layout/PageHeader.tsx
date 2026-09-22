import type { ReactNode } from 'react';

export const PageHeader = ({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): JSX.Element => (
  <div className="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 className="text-base font-semibold tracking-tight text-ink">{title}</h1>
      {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
    </div>
    {actions}
  </div>
);
