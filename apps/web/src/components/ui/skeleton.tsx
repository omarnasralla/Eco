import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Loading placeholder. Sized to the content it replaces to avoid layout shift. */
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
