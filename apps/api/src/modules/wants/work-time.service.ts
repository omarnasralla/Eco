import { Injectable } from '@nestjs/common';
import { addMonths, hourlyRateMinor } from '@eco/core';
import type { WorkRateDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { IncomeService } from '../income/income.service';
import { todayIso } from '../../common/utils/dates';

/**
 * What an hour of the user's work earns, in their base currency.
 *
 * Divided from the income run rate — what recurring sources pay now — because
 * that is what a person means by "what I earn". Someone who records receipts
 * but no sources still gets a rate, from the last three complete months of
 * money actually received.
 */
@Injectable()
export class WorkTimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly income: IncomeService,
  ) {}

  async rate(userId: string, currency: string): Promise<WorkRateDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { workHoursPerWeek: true },
    });

    let monthlyIncomeMinor = await this.income.monthlyTotal(userId, currency);
    let basis: WorkRateDto['basis'] = monthlyIncomeMinor > 0 ? 'RECURRING' : null;

    if (monthlyIncomeMinor === 0) {
      // Complete months only: the month in progress has not been paid yet,
      // and averaging it in would cut the rate by up to a third.
      const thisMonth = todayIso().slice(0, 7);
      const months = [1, 2, 3].map((offset) => addMonths(thisMonth, -offset));
      const breakdown = await this.income.incomeBreakdownByMonth(userId, currency, months);
      const received = months.reduce((sum, m) => sum + (breakdown.get(m)?.received ?? 0), 0);
      monthlyIncomeMinor = Math.round(received / months.length);
      basis = monthlyIncomeMinor > 0 ? 'RECEIVED' : null;
    }

    return {
      hourlyMinor: hourlyRateMinor(monthlyIncomeMinor, user.workHoursPerWeek),
      currency,
      workHoursPerWeek: user.workHoursPerWeek,
      monthlyIncomeMinor,
      basis,
    };
  }
}
