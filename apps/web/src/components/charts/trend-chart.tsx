'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendPointDto } from '@eco/shared';
import { useMoneyFormat } from '@/lib/auth-provider';
import { shortMonth } from '@/lib/utils';
import { axisProps, useChartTheme } from './chart-theme';
import { ChartTooltip, moneyFormatter } from './chart-tooltip';

/**
 * Income against expenses over time.
 *
 * Both series are drawn in neutral categorical slots rather than green and red.
 * The convention is tempting, but on a line chart there is no arrow or sign to
 * fall back on when a reader cannot separate those two hues — and this is
 * exactly the pair colour-vision deficiency erases. The legend plus an end
 * label carries identity instead. Green and red are reserved for deltas, where
 * they always ride alongside a glyph.
 */
export function TrendChart({ data, height = 240 }: { data: TrendPointDto[]; height?: number }) {
  const theme = useChartTheme();
  const { currency, locale } = useMoneyFormat();
  const money = moneyFormatter(currency, locale);

  const incomeColor = theme.series(0);
  const expenseColor = theme.series(1);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        No history yet — add some income and expenses to see your trend.
      </div>
    );
  }

  return (
    <div>
      {/* Legend is always present for two or more series. */}
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: incomeColor }} />
          Income
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: expenseColor }} />
          Expenses
        </span>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={theme.grid} strokeWidth={1} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => shortMonth(m, locale)} {...axisProps(theme.axisText)} />
          <YAxis
            // Compact ticks keep the axis narrow enough for a phone without
            // dropping to unlabelled gridlines.
            tickFormatter={(v: number) => money(v, true)}
            width={52}
            {...axisProps(theme.axisText)}
          />
          <Tooltip
            cursor={{ stroke: theme.grid, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as TrendPointDto;
              return (
                <ChartTooltip
                  title={shortMonth(String(label), locale)}
                  rows={[
                    { label: 'Income', value: money(point.incomeMinor), color: incomeColor },
                    { label: 'Expenses', value: money(point.expensesMinor), color: expenseColor },
                    {
                      label: 'Net',
                      value: money(point.netMinor),
                      color: point.netMinor >= 0 ? theme.positive : theme.negative,
                    },
                  ]}
                />
              );
            }}
          />
          {/* A wash, never a saturated block. */}
          <Area
            type="monotone"
            dataKey="incomeMinor"
            stroke="none"
            fill={incomeColor}
            fillOpacity={0.1}
          />
          <Line
            type="monotone"
            dataKey="incomeMinor"
            stroke={incomeColor}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: theme.surface }}
          />
          <Line
            type="monotone"
            dataKey="expensesMinor"
            stroke={expenseColor}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: theme.surface }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
