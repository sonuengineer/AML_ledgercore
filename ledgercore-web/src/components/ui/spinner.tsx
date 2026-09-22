import { cn } from '@/lib/cn';

export const Spinner = ({ className }: { className?: string }): JSX.Element => (
  <span
    role="status"
    aria-label="Loading"
    className={cn(
      'inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted/40 border-t-brand',
      className,
    )}
  />
);

export const LoadingRow = ({ label = 'Loading' }: { label?: string }): JSX.Element => (
  <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
    <Spinner />
    <span>{label}</span>
  </div>
);
