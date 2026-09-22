import type { HTMLAttributes, ReactNode, TdHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export const Table = ({ className, ...props }: HTMLAttributes<HTMLTableElement>): JSX.Element => (
  <div className="w-full overflow-x-auto">
    <table className={cn('w-full border-collapse text-sm', className)} {...props} />
  </div>
);

export const Th = ({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element => (
  <th
    className={cn(
      'border-b border-line bg-raised px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted',
      className,
    )}
    {...props}
  />
);

export const Td = ({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): JSX.Element => (
  <td className={cn('border-b border-line px-3 py-2 align-middle text-ink', className)} {...props} />
);

export const Tr = ({
  className,
  interactive = false,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }): JSX.Element => (
  <tr
    className={cn(interactive && 'cursor-pointer hover:bg-raised/70', className)}
    {...props}
  />
);

export const EmptyRow = ({ colSpan, children }: { colSpan: number; children: ReactNode }): JSX.Element => (
  <tr>
    <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-muted">
      {children}
    </td>
  </tr>
);
