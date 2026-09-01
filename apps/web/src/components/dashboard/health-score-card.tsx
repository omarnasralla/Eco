'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useChartTheme } from '@/components/charts/chart-theme';
import type { HealthScore } from '@/lib/queries';

const BAND_COPY: Record<HealthScore['band'], string> = {
  EXCELLENT: 'Your finances are in strong shape.',
  GOOD: 'Solid overall, with a little room to improve.',
  FAIR: 'Workable, but a few things need attention.',
  AT_RISK: 'Several areas need work — start with the biggest.',
  CRITICAL: 'This needs attention now. Focus on one thing at a time.',
};

export function HealthScoreCard({
  data,
  loading,
}: {
  data?: HealthScore;
  loading?: boolean;
}) {
  const theme = useChartTheme();

  if (loading || !data) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Financial health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-10 w-24" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  // The score is graded, so a single hue stepped by band reads as a scale;
  // the band name beside it means the colour is never doing the work alone.
  const scoreColor =
    data.score >= 70 ? theme.positive : data.score >= 50 ? '#c87f00' : theme.negative;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Financial health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex items-baseline gap-2">
          <span className="tabular text-4xl font-semibold" style={{ color: scoreColor }}>
            {data.score}
          </span>
          <span className="text-sm text-muted-foreground">/ 100</span>
          <span className="ml-auto text-sm font-medium capitalize">
            {data.band.toLowerCase().replace('_', ' ')}
          </span>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">{BAND_COPY[data.band]}</p>

        <ul className="space-y-3">
          {data.components.map((component) => (
            <li key={component.name}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className="text-foreground">{component.name}</span>
                <span className="tabular text-muted-foreground">{component.score}</span>
              </div>
              <Progress
                value={component.score}
                aria-label={`${component.name}: ${component.score} out of 100`}
              />
              <p className="mt-1 text-xs text-muted-foreground">{component.detail}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
