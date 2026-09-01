import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { EcoMark } from '@/components/layout/eco-mark';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <EcoMark className="size-10" />
      <h1 className="text-2xl font-semibold">We could not find that page</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The link may be out of date, or the page may have moved.
      </p>
      <Button asChild className="mt-2">
        <Link href="/dashboard">Back to your dashboard</Link>
      </Button>
    </div>
  );
}
