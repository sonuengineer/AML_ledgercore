import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Card = ({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div className={cn('rounded border border-line bg-surface', className)} {...props} />
);

export const CardHeader = ({
  title,
  action,
  description,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}): JSX.Element => (
  <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
    <div>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
    </div>
    {action}
  </div>
);

export const CardBody = ({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div className={cn('px-4 py-3', className)} {...props} />
);

/** Label/value pair -- the densest readable way to show a record's fields. */
export const Field = ({ label, value }: { label: string; value: ReactNode }): JSX.Element => (
  <div className="min-w-0">
    <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
    <dd className="mt-0.5 truncate text-sm text-ink">{value}</dd>
  </div>
);
