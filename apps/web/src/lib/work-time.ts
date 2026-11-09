'use client';

import { useQuery } from '@tanstack/react-query';
import { formatWorkTime, workHoursFor } from '@eco/core';
import type { WorkRateDto } from '@eco/shared';
import { api } from './api-client';

export const workRateKey = ['wants', 'work-rate'] as const;

/**
 * What an hour of the user's work earns. Shared by every screen that restates
 * a price as time, and slow to change — it moves only when income or the
 * hours setting does, both of which invalidate it.
 */
export function useWorkRate() {
  return useQuery({
    queryKey: workRateKey,
    queryFn: () => api.get<WorkRateDto>('/wants/work-rate'),
    staleTime: 10 * 60 * 1000,
  });
}

/**
 * "6 h", "1.5 days" — or null when there is no rate to divide by, so the
 * caller renders nothing rather than a made-up figure.
 */
export function workTimeLabel(
  baseAmountMinor: number,
  rate: WorkRateDto | undefined,
): string | null {
  if (!rate?.hourlyMinor || !rate.workHoursPerWeek) return null;
  const hours = workHoursFor(baseAmountMinor, rate.hourlyMinor);
  return hours === null ? null : formatWorkTime(hours, rate.workHoursPerWeek);
}
