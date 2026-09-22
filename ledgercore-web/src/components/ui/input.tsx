import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid = false, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-9 w-full rounded border bg-surface px-3 text-sm text-ink',
        'placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/60',
        'disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-danger' : 'border-line',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Label = ({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>): JSX.Element => (
  <label className={cn('mb-1 block text-xs font-medium text-muted', className)} {...props} />
);

export const FieldError = ({ children }: { children?: string | undefined }): JSX.Element | null =>
  children ? <p className="mt-1 text-xs text-danger">{children}</p> : null;
