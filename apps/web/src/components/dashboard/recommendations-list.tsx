'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowRight, Lightbulb, X } from 'lucide-react';
import type { RecommendationDto } from '@eco/shared';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const PRIORITY_VARIANT = {
  HIGH: 'destructive',
  MEDIUM: 'warning',
  LOW: 'secondary',
} as const;

/**
 * Recommendations, with their evidence.
 *
 * Every one of these was computed deterministically from the user's own ledger,
 * so the numbers behind it are shown rather than hidden. Advice a user cannot
 * check is advice they have to take on faith, and financial advice on faith is
 * how people get hurt.
 */
export function RecommendationsList({
  data,
  loading,
  limit,
}: {
  data?: RecommendationDto[];
  loading?: boolean;
  limit?: number;
}) {
  const queryClient = useQueryClient();

  const dismiss = useMutation({
    mutationFn: (id: string) => api.post(`/ai/recommendations/${id}/dismiss`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.recommendations }),
  });

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What to do next</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  const items = limit ? (data ?? []).slice(0, limit) : (data ?? []);

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What to do next</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing needs your attention right now. Eco checks every night and will tell you when
            something changes.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-primary" aria-hidden />
          What to do next
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {items.map((item) => (
          <article key={item.id} className="rounded-lg border p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium leading-snug">{item.title}</h3>
              <div className="flex shrink-0 items-center gap-1">
                <Badge variant={PRIORITY_VARIANT[item.priority]}>
                  {item.priority.toLowerCase()}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Dismiss: ${item.title}`}
                  onClick={() => dismiss.mutate(item.id)}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">{item.body}</p>

            {item.evidence.length > 0 ? (
              <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-2 text-xs">
                {item.evidence.map((row) => (
                  <div key={row.label} className="flex gap-1.5">
                    <dt className="text-muted-foreground">{row.label}:</dt>
                    <dd className="tabular font-medium">{row.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {item.actionUrl ? (
              <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
                <Link href={item.actionUrl}>
                  Take a look
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </Button>
            ) : null}
          </article>
        ))}
      </CardContent>
    </Card>
  );
}
