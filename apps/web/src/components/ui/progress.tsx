// Minimal copy of the shadcn/ui Progress (same API), used by the site. Registry items depend on the real one.
import type * as React from 'react';
import { cn } from '@/lib/utils';

export function Progress({ className, value, ...props }: React.ComponentProps<'div'> & { value?: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
      {...props}
    >
      <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${value ?? 0}%` }} />
    </div>
  );
}
