import { cn } from '@/lib/utils';

/**
 * The Eco mark: a leaf whose midrib doubles as a rising trend line — growth in
 * both senses. Drawn rather than imported so it inherits `currentColor` and
 * needs no asset pipeline.
 */
export function EcoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn('text-primary', className)}
    >
      <path
        d="M20 4c0 9.5-5.2 15-12 15a9.6 9.6 0 0 1-3.6-.7C3.4 12.6 8 5.4 20 4Z"
        fill="currentColor"
        fillOpacity="0.18"
      />
      <path
        d="M20 4c0 9.5-5.2 15-12 15a9.6 9.6 0 0 1-3.6-.7C3.4 12.6 8 5.4 20 4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M4 21c1.6-5.4 5.1-9.7 10-12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
