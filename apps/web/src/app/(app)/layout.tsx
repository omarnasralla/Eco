'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-provider';
import { DisplayCurrencyProvider } from '@/lib/display-currency';
import { MobileNav } from '@/components/layout/mobile-nav';
import { Sidebar } from '@/components/layout/sidebar';
import { CurrencyToggle } from '@/components/layout/currency-toggle';

/**
 * Guards every signed-in route.
 *
 * The check runs client-side because the access token lives in JS (see
 * lib/tokens.ts for that trade-off). It is a routing convenience, not the
 * security boundary — the API authorises every request independently, so a
 * user who bypasses this sees an empty shell and 401s, never another person's
 * data.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace('/login');
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return (
    <DisplayCurrencyProvider>
      <div className="min-h-dvh bg-background">
        <Sidebar />
        {/* Bottom padding clears the mobile tab bar; the left offset clears the
            desktop sidebar. */}
        <main className="pb-24 lg:ml-60 lg:pb-8">
          <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-8">
            <CurrencyToggle />
            {children}
          </div>
        </main>
        <MobileNav />
      </div>
    </DisplayCurrencyProvider>
  );
}
