'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PayoffScheduleEntryDto } from '@eco/shared';
import { useChartMoney, useDisplayCurrency } from '@/lib/display-currency';
import { shortMonth } from '@/lib/utils';
import { axisProps, useChartTheme } from './chart-theme';
import { ChartTooltip } from './chart-tooltip';

/**
 * Debt balances falling to zero under a payoff plan.
 *
 * One line per debt, capped at the palette's separable range. Past that the
 * chart would be asserting distinctions the eye cannot make, so the tail is
 * summed into a single "Other debts" line.
 */
export function PayoffChart({
  schedule,
  height = 260,
}: {
  schedule: PayoffScheduleEntryDto[];
  height?: number;
}) {
  const theme = useChartTheme();
  const money = useChartMoney();
  const { locale } = useDisplayCurrency();

  if (schedule.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        Build a payoff plan to see your balances fall.
      </div>
    );
  }

  const debtNames = [...new Set(schedule.map((row) => row.debtName))];
  const MAX_LINES = 5;
  const named = debtNames.slice(0, MAX_LINES);
  const folded = debtNames.slice(MAX_LINES);

  const byMonth = new Map<string, Record<string, number | string>>();
  for (const row of schedule) {
    const entry = byMonth.get(row.month) ?? { month: row.month };
    const key = named.includes(row.debtName) ? row.debtName : 'Other debts';
    entry[key] = ((entry[key] as number) ?? 0) + row.endingBalanceMinor;
    byMonth.set(row.month, entry);
  }

  const data = [...byMonth.values()].sort((a, b) =>
    String(a.month).localeCompare(String(b.month)),
  );
  const series = [...named, ...(folded.length > 0 ? ['Other debts'] : [])];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid stroke={theme.grid} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="month"
          tickFormatter={(m: string) => shortMonth(m, locale)}
          minTickGap={24}
          {...axisProps(theme.axisText)}
        />
        <YAxis tickFormatter={(v: number) => money(v, true)} width={52} {...axisProps(theme.axisText)} />
        <Tooltip
          cursor={{ stroke: theme.grid, strokeWidth: 1 }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            return (
              <ChartTooltip
                title={shortMonth(String(label), locale)}
                rows={payload
                  .filter((item) => Number(item.value) > 0)
                  .map((item) => ({
                    label: String(item.name),
                    value: money(Number(item.value)),
                    color: String(item.color),
                  }))}
              />
            );
          }}
        />
        <Legend
          iconType="plainline"
          wrapperStyle={{ fontSize: 12, color: theme.axisText, paddingTop: 8 }}
        />
        {series.map((name, index) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={theme.series(index)}
            strokeWidth={2}
            strokeLinecap="round"
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: theme.surface }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
