'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { adaptToSurface, DIRECTION, seriesColor } from '@/lib/chart-colors';

/**
 * Resolves the active chart mode.
 *
 * `next-themes` reports "system" until the client has mounted, so charts read
 * `resolvedTheme` and hold "light" through the first paint rather than
 * flickering between palettes on hydration.
 */
export function useChartMode(): 'light' | 'dark' {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted && resolvedTheme === 'dark' ? 'dark' : 'light';
}

export function useChartTheme() {
  const mode = useChartMode();

  return {
    mode,
    /** Recessive, one step off the surface — never dashed. */
    grid: mode === 'dark' ? '#242b3a' : '#e7e9ee',
    axisText: mode === 'dark' ? '#8b95a8' : '#64748b',
    surface: mode === 'dark' ? '#12161f' : '#ffffff',
    tooltipBg: mode === 'dark' ? '#1a2130' : '#ffffff',
    tooltipBorder: mode === 'dark' ? '#2a3346' : '#e2e8f0',
    series: (index: number) => seriesColor(index, mode),
    /** Adapts a user-chosen category colour to the current surface. */
    category: (hex: string) => adaptToSurface(hex, mode),
    positive: DIRECTION.positive[mode],
    negative: DIRECTION.negative[mode],
  };
}

/** Shared axis styling so every chart's chrome is identically recessive. */
export const axisProps = (color: string) => ({
  stroke: color,
  tick: { fill: color, fontSize: 11 },
  tickLine: false,
  axisLine: false,
});
