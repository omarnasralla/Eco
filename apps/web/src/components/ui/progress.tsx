'use client';

import * as ProgressPrimitive from '@radix-ui/react-progress';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils';

interface ProgressProps
  extends ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** Overrides the fill colour, e.g. a category or goal colour. */
  indicatorClassName?: string;
  indicatorStyle?: React.CSSProperties;
}

const Progress = forwardRef<ElementRef<typeof ProgressPrimitive.Root>, ProgressProps>(
  ({ className, value, indicatorClassName, indicatorStyle, ...props }, ref) => (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn('h-full w-full flex-1 bg-primary transition-transform', indicatorClassName)}
        style={{ transform: `translateX(-${100 - Math.min(value ?? 0, 100)}%)`, ...indicatorStyle }}
      />
    </ProgressPrimitive.Root>
  ),
);
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
