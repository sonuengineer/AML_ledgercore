import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'info' | 'warn' | 'danger';

const tones: Record<Tone, string> = {
  info: 'border-brand/40 bg-brand/5 text-ink',
  warn: 'border-warn/40 bg-warn/5 text-ink',
  danger: 'border-danger/40 bg-danger/5 text-ink',
};

const titleTones: Record<Tone, string> = {
  info: 'text-brand',
  warn: 'text-warn',
  danger: 'text-danger',
};

export const Alert = ({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}): JSX.Element => (
  <div role="alert" className={cn('rounded border px-3 py-2 text-sm', tones[tone], className)}>
    {title ? <p className={cn('font-semibold', titleTones[tone])}>{title}</p> : null}
    {children ? <div className={cn(title && 'mt-1', 'text-ink/90')}>{children}</div> : null}
  </div>
);
