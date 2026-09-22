import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { BranchStatus, DayStatus, UserStatus } from '@/types/api';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-raised text-muted border-line',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  danger: 'bg-danger/10 text-danger border-danger/30',
  info: 'bg-brand/10 text-brand border-brand/30',
};

export const Badge = ({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}): JSX.Element => (
  <span
    className={cn(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide',
      tones[tone],
      className,
    )}
  >
    {children}
  </span>
);

// Status -> tone lives here so every table agrees on what "LOCKED" looks like.
const statusTones: Record<string, Tone> = {
  ACTIVE: 'ok',
  OPEN: 'ok',
  PENDING: 'warn',
  CLOSING: 'warn',
  SUSPENDED: 'warn',
  LOCKED: 'danger',
  DISABLED: 'danger',
  CLOSED: 'neutral',
};

export const StatusBadge = ({
  status,
}: {
  status: BranchStatus | DayStatus | UserStatus;
}): JSX.Element => <Badge tone={statusTones[status] ?? 'neutral'}>{status}</Badge>;
