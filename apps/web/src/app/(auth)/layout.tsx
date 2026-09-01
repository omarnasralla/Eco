import { EcoMark } from '@/components/layout/eco-mark';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/30 px-4 py-10">
      <div className="mb-8 flex items-center gap-2.5">
        <EcoMark className="size-8" />
        <span className="text-2xl font-semibold tracking-tight">Eco</span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
      <p className="mt-8 max-w-sm text-center text-xs text-muted-foreground">
        Eco keeps your financial data on infrastructure you control, and never sends it to a
        third-party model.
      </p>
    </div>
  );
}
