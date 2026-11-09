'use client';

import { useQuery } from '@tanstack/react-query';
import { Sunrise } from 'lucide-react';
import type { BriefingDto } from '@eco/shared';
import { api } from '@/lib/api-client';
import { PageHeader } from '@/components/layout/page-header';
import { WeatherCard } from '@/components/today/weather-card';
import { TasksCard } from '@/components/today/tasks-card';
import { BirthdaysCard } from '@/components/today/birthdays-card';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The morning briefing, opened out.
 *
 * Where the push lands. The briefing itself sits at the top, exactly as it was
 * sent, with the three non-money pieces it draws on below it — so a line in
 * the notification is always one scroll from the place it can be acted on.
 */
export default function TodayPage() {
  const briefing = useQuery({
    queryKey: ['briefing'],
    queryFn: () => api.get<BriefingDto>('/briefing'),
  });

  const heading = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <>
      <PageHeader title="Today" description={heading} />

      <div className="space-y-4">
        <Card>
          <CardContent className="p-4">
            {briefing.isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : briefing.data ? (
              <>
                <p className="flex items-center gap-2 font-medium">
                  <Sunrise className="size-4 shrink-0 text-primary" aria-hidden />
                  {briefing.data.title}
                </p>
                <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                  {briefing.data.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">The briefing could not be loaded.</p>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <WeatherCard />
            <BirthdaysCard />
          </div>
          <TasksCard />
        </div>
      </div>
    </>
  );
}
