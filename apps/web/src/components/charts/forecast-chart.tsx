'use client';

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ForecastDto } from '@eco/shared';
import { useChartMoney, useDisplayCurrency } from '@/lib/display-currency';
import { shortMonth } from '@/lib/utils';
import { axisProps, useChartTheme } from './chart-theme';
import { ChartTooltip } from './chart-tooltip';

/**
 * Projected cash balance with its prediction interval.
 *
 * The band is the point of this chart. A single confident line implies a
 * precision the model does not have; showing the 80% interval is what makes it
 * honest — and it is what turns "you will have £14,800" into "somewhere between
 * £11,000 and £18,000, and here is where that dips below zero".
 */
export function ForecastChart({
  forecast,
  height = 260,
}: {
  forecast: ForecastDto;
  height?: number;
}) {
  const theme = useChartTheme();
  const money = useChartMoney();
  const { locale } = useDisplayCurrency();

  const lineColor = theme.series(0);

  // Recharts stacks areas by value, so the band is expressed as a floor plus
  // the span above it: an invisible area to the lower bound, then a visible
  // one for the interval itself.
  const data = forecast.points.map((point) => {
    const lower = point.projectedBalanceMinor - point.projectedNetMinor + point.lowerBoundMinor;
    const upper = point.projectedBalanceMinor - point.projectedNetMinor + point.upperBoundMinor;
    return {
      ...point,
      bandFloor: Math.min(lower, upper),
      bandSpan: Math.abs(upper - lower),
    };
  });

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center px-6 text-center text-sm text-muted-foreground"
        style={{ height }}
      >
        Not enough history yet to project forward. Keep recording expenses and a forecast
        will appear here.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 rounded-full" style={{ background: lineColor }} />
          Projected balance
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="h-2.5 w-4 rounded-sm"
            style={{ background: lineColor, opacity: 0.12 }}
          />
          80% range
        </span>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={theme.grid} strokeWidth={1} vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => shortMonth(m, locale)} {...axisProps(theme.axisText)} />
          <YAxis tickFormatter={(v: number) => money(v, true)} width={52} {...axisProps(theme.axisText)} />

          {/* Zero is the line that matters on a balance chart. */}
          <ReferenceLine y={0} stroke={theme.negative} strokeWidth={1} />

          <Tooltip
            cursor={{ stroke: theme.grid, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as (typeof data)[number];
              return (
                <ChartTooltip
                  title={shortMonth(String(label), locale)}
                  rows={[
                    {
                      label: 'Projected balance',
                      value: money(point.projectedBalanceMinor),
                      color: lineColor,
                    },
                    { label: 'Income', value: money(point.projectedIncomeMinor) },
                    { label: 'Expenses', value: money(point.projectedExpensesMinor) },
                    {
                      label: 'Net',
                      value: money(point.projectedNetMinor),
                      color:
                        point.projectedNetMinor >= 0 ? theme.positive : theme.negative,
                    },
                  ]}
                  footnote={
                    point.isShortfall
                      ? 'This month could run short on the pessimistic path.'
                      : undefined
                  }
                />
              );
            }}
          />

          <Area dataKey="bandFloor" stackId="band" stroke="none" fill="transparent" />
          <Area
            dataKey="bandSpan"
            stackId="band"
            stroke="none"
            fill={lineColor}
            fillOpacity={0.12}
          />

          <Line
            type="monotone"
            dataKey="projectedBalanceMinor"
            stroke={lineColor}
            strokeWidth={2}
            strokeLinecap="round"
            dot={(props) => {
              const point = data[props.index];
              if (!point?.isShortfall) return <g key={props.key} />;
              // Only shortfall months get a marker — a dot on every point is
              // noise, a dot on the one that matters is a signal.
              return (
                <circle
                  key={props.key}
                  cx={props.cx}
                  cy={props.cy}
                  r={4}
                  fill={theme.negative}
                  stroke={theme.surface}
                  strokeWidth={2}
                />
              );
            }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: theme.surface }}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <p className="mt-3 text-xs text-muted-foreground">
        {forecast.model === 'holt-winters-seasonal'
          ? 'Seasonal model fitted to your last two years.'
          : 'Trend model fitted to your recent months.'}{' '}
        Confidence {Math.round(forecast.confidence * 100)}%.
        {forecast.warnings.length > 0 ? ` ${forecast.warnings[0]}` : ''}
      </p>
    </div>
  );
}
