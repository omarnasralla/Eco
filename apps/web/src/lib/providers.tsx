'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { ApiError } from './api-client';
import { AuthProvider } from './auth-provider';

export function Providers({ children }: { children: ReactNode }) {
  // Created in state so each browser session gets one client, and so a Next.js
  // server render never shares a cache between two users' requests.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Financial data changes when the user changes it, not on a timer.
            // A minute of staleness avoids refetching a dashboard on every
            // tab focus while still feeling live after an edit.
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Retrying a 4xx just repeats the same rejection; only transient
              // failures are worth another attempt.
              if (error instanceof ApiError && error.status < 500) return false;
              return failureCount < 2;
            },
          },
          mutations: { retry: false },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <AuthProvider>{children}</AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
