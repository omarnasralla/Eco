import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addMonths, expectedIncomeInMonth, toMonthlyMinor } from '@eco/core';
import type {
  IncomeReceiptDto,
  IncomeSourceDto,
  IncomeSourceInput,
  StandaloneReceiptInput,
} from '@eco/shared';
import type { IncomeSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import {
  fromIsoDate,
  monthToDate,
  requireIsoDate,
  toIsoDate,
  todayIso,
} from '../../common/utils/dates';

function toReceiptDto(
  receipt: {
    id: string;
    name: string | null;
    incomeSourceId: string | null;
    accountId: string | null;
    amountMinor: bigint;
    currency: string;
    baseAmountMinor: bigint;
    date: Date;
    notes: string | null;
    createdAt: Date;
  },
  sourceName: string | null,
): IncomeReceiptDto {
  return {
    id: receipt.id,
    name: receipt.name ?? sourceName ?? 'Payment',
    incomeSourceId: receipt.incomeSourceId,
    accountId: receipt.accountId,
    amountMinor: toNumber(receipt.amountMinor),
    currency: receipt.currency,
    baseAmountMinor: toNumber(receipt.baseAmountMinor),
    date: requireIsoDate(receipt.date),
    notes: receipt.notes,
    createdAt: receipt.createdAt.toISOString(),
  };
}

function toDto(source: IncomeSource): IncomeSourceDto {
  const amountMinor = toNumber(source.amountMinor);
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    amountMinor,
    currency: source.currency,
    frequency: source.frequency,
    startDate: requireIsoDate(source.startDate),
    endDate: toIsoDate(source.endDate),
    isActive: source.isActive,
    notes: source.notes,
    accountId: source.accountId,
    // Derived in @eco/core so web, API and React Native all agree on what a
    // weekly wage is worth per month.
    monthlyEquivalentMinor: toMonthlyMinor(amountMinor, source.frequency),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

@Injectable()
export class IncomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  async findAll(userId: string, includeInactive = false): Promise<IncomeSourceDto[]> {
    const sources = await this.prisma.incomeSource.findMany({
      where: { userId, deletedAt: null, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ isActive: 'desc' }, { amountMinor: 'desc' }],
    });
    return sources.map(toDto);
  }

  async findOne(userId: string, id: string): Promise<IncomeSourceDto> {
    const source = await this.prisma.incomeSource.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Income source not found');
    return toDto(source);
  }

  async create(userId: string, input: IncomeSourceInput): Promise<IncomeSourceDto> {
    if (input.accountId) await this.requireOwnedAccount(userId, input.accountId);

    const source = await this.prisma.incomeSource.create({
      data: {
        userId,
        name: input.name,
        type: input.type,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        frequency: input.frequency,
        startDate: fromIsoDate(input.startDate),
        endDate: input.endDate ? fromIsoDate(input.endDate) : null,
        isActive: input.isActive,
        accountId: input.accountId ?? null,
        notes: input.notes ?? null,
      },
    });
    await this.redis.invalidateUser(userId);
    return toDto(source);
  }

  async update(
    userId: string,
    id: string,
    input: Partial<IncomeSourceInput>,
  ): Promise<IncomeSourceDto> {
    const existing = await this.prisma.incomeSource.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Income source not found');

    if (input.accountId) await this.requireOwnedAccount(userId, input.accountId);

    // `updateIncomeSourceSchema` is `incomeSourceSchema.innerType().partial()`,
    // and `innerType()` drops the refine that keeps the end date on or after
    // the start — so on this path the rule has to be enforced here. It also has
    // to be enforced against the *effective* window rather than the payload:
    // an edit that sends only an end date, or only a start date, is still
    // capable of inverting the pair. An inverted window is not cosmetic, since
    // `monthlyTotal` now counts a source only while it is running: the source
    // would silently stop counting, which is the same "income stays flat and
    // nothing says why" confusion the date filter exists to prevent.
    const effectiveStart =
      input.startDate !== undefined ? input.startDate : toIsoDate(existing.startDate);
    const effectiveEnd =
      input.endDate !== undefined ? input.endDate : toIsoDate(existing.endDate);
    if (effectiveEnd && effectiveStart && effectiveEnd < effectiveStart) {
      throw new BadRequestException('End date must fall on or after the start date');
    }

    const source = await this.prisma.incomeSource.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
        ...(input.startDate !== undefined ? { startDate: fromIsoDate(input.startDate) } : {}),
        ...(input.endDate !== undefined
          ? { endDate: input.endDate ? fromIsoDate(input.endDate) : null }
          : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });

    await this.redis.invalidateUser(userId);
    return toDto(source);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.incomeSource.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    });
    if (count === 0) throw new NotFoundException('Income source not found');
    await this.redis.invalidateUser(userId);
  }

  /** Records an actual payment landing, distinct from the expected schedule. */
  async recordReceipt(
    userId: string,
    incomeSourceId: string,
    input: { amountMinor: number; date: string; accountId?: string | null; notes?: string | null },
    userCurrency: string,
  ) {
    const source = await this.prisma.incomeSource.findFirst({
      where: { id: incomeSourceId, userId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Income source not found');

    if (input.accountId) await this.requireOwnedAccount(userId, input.accountId);

    // Explicit input wins; otherwise fall back to the source's own account —
    // set once, a recurring payday needs no re-picking every month. An
    // explicit null still means "not into a tracked account", for the month
    // the money arrived somewhere else.
    const accountId = input.accountId !== undefined ? input.accountId : source.accountId;

    const receipt = await this.prisma.incomeReceipt.create({
      data: {
        userId,
        incomeSourceId,
        accountId,
        amountMinor: BigInt(input.amountMinor),
        currency: source.currency,
        baseAmountMinor: BigInt(
          await this.currency.convert(
            input.amountMinor,
            source.currency,
            userCurrency,
            input.date,
          ),
        ),
        date: fromIsoDate(input.date),
        notes: input.notes ?? null,
      },
    });

    await this.redis.invalidateUser(userId);
    return toReceiptDto(receipt, source.name);
  }

  /**
   * A payment with no schedule behind it.
   *
   * Recording a one-off as an income *source* made it a rate it is not: it
   * contributes nothing to the run rate, correctly, and so the money landed
   * nowhere. As a receipt it does the one thing it should — move the balance of
   * the account it landed in.
   */
  async recordStandaloneReceipt(
    userId: string,
    input: StandaloneReceiptInput,
    userCurrency: string,
  ): Promise<IncomeReceiptDto> {
    if (input.accountId) await this.requireOwnedAccount(userId, input.accountId);

    const receipt = await this.prisma.incomeReceipt.create({
      data: {
        userId,
        incomeSourceId: null,
        name: input.name,
        accountId: input.accountId ?? null,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        baseAmountMinor: BigInt(
          await this.currency.convert(input.amountMinor, input.currency, userCurrency, input.date),
        ),
        date: fromIsoDate(input.date),
        notes: input.notes ?? null,
      },
    });

    await this.redis.invalidateUser(userId);
    return toReceiptDto(receipt, input.name);
  }

  /** Payments actually received, newest first. */
  async listReceipts(userId: string, limit = 50): Promise<IncomeReceiptDto[]> {
    const receipts = await this.prisma.incomeReceipt.findMany({
      where: { userId },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      include: { incomeSource: { select: { name: true } } },
    });
    return receipts.map((r) => toReceiptDto(r, r.incomeSource?.name ?? null));
  }

  async removeReceipt(userId: string, id: string): Promise<void> {
    // Hard delete: a receipt is a record of a payment, and an entry made in
    // error should leave nothing behind moving a balance it never should have.
    const { count } = await this.prisma.incomeReceipt.deleteMany({ where: { id, userId } });
    if (count === 0) throw new NotFoundException('Receipt not found');
    await this.redis.invalidateUser(userId);
  }

  private async requireOwnedAccount(userId: string, accountId: string): Promise<void> {
    const owned = await this.prisma.financialAccount.count({
      where: { id: accountId, userId, deletedAt: null },
    });
    if (owned === 0) throw new NotFoundException('Account not found');
  }

  /**
   * What each of `months` actually earned, in the user's base currency.
   *
   * The run rate below answers "what do you earn per month"; this answers "what
   * came in during August", and they are different questions. A person paid
   * once, or irregularly, has a run rate of zero and is not living on zero —
   * which is exactly what the dashboard used to claim.
   *
   * Two sources of truth, in priority order:
   *
   *   1. Receipts — money that actually arrived, dated when it arrived. This is
   *      the only way a one-off payment or an untracked windfall counts at all.
   *   2. Sources with no receipt in that month — still expected, so a salaried
   *      user who never records receipts sees their salary rather than nothing.
   *
   * A source that *has* been receipted in a month is skipped: the receipt is
   * the actual figure, and counting both would report a doubled salary. Pay
   * dates come from `expectedIncomeInMonth`, so a one-off lands only in its own
   * month and a three-paycheque month reads as three paycheques.
   *
   * One honest limitation: a deleted source stops counting in past months too,
   * because a soft delete records no date. Receipts are unaffected, which is
   * the other reason recording them is worth it.
   */
  /**
   * Received and still-expected income, kept apart.
   *
   * They answer different questions and must not be added together by
   * accident: one is money in an account, the other is a forecast. A headline
   * that nets a prediction against real spending states a number the user does
   * not have.
   */
  async incomeBreakdownByMonth(
    userId: string,
    userCurrency: string,
    months: string[],
  ): Promise<Map<string, { received: number; expected: number }>> {
    const totals = new Map<string, { received: number; expected: number }>(
      months.map((m) => [m, { received: 0, expected: 0 }]),
    );
    if (months.length === 0) return totals;

    const sorted = [...months].sort();
    const windowStart = monthToDate(sorted[0]!);
    // Exclusive upper bound: the first day of the month after the last one.
    const windowEnd = monthToDate(addMonths(sorted.at(-1)!, 1));

    const [receipts, sources] = await Promise.all([
      this.prisma.incomeReceipt.findMany({
        where: { userId, date: { gte: windowStart, lt: windowEnd } },
        select: { amountMinor: true, currency: true, date: true, incomeSourceId: true },
      }),
      this.prisma.incomeSource.findMany({ where: { userId, deletedAt: null } }),
    ]);

    // Which sources are already accounted for by a real payment, per month.
    const receiptedByMonth = new Map<string, Set<string>>();

    for (const receipt of receipts) {
      const month = requireIsoDate(receipt.date).slice(0, 7);
      if (!totals.has(month)) continue;
      if (receipt.incomeSourceId) {
        const seen = receiptedByMonth.get(month) ?? new Set<string>();
        seen.add(receipt.incomeSourceId);
        receiptedByMonth.set(month, seen);
      }
      const bucket = totals.get(month)!;
      bucket.received += await this.currency.convertForDisplay(
        toNumber(receipt.amountMinor),
        receipt.currency,
        userCurrency,
      );
    }

    for (const month of months) {
      const receipted = receiptedByMonth.get(month);
      for (const source of sources) {
        if (receipted?.has(source.id)) continue;
        const expected = expectedIncomeInMonth(
          {
            amountMinor: toNumber(source.amountMinor),
            frequency: source.frequency as Parameters<typeof expectedIncomeInMonth>[0]['frequency'],
            startDate: requireIsoDate(source.startDate),
            endDate: toIsoDate(source.endDate),
            isActive: source.isActive,
          },
          month,
        );
        if (expected === 0) continue;
        totals.get(month)!.expected += await this.currency.convertForDisplay(
          expected,
          source.currency,
          userCurrency,
        );
      }
    }

    return totals;
  }

  /**
   * Received plus expected, as a single figure. Correct for a complete month,
   * where nothing is still outstanding; misleading as a headline for the month
   * in progress, which is why the dashboard asks for the breakdown instead.
   */
  async incomeByMonth(
    userId: string,
    userCurrency: string,
    months: string[],
  ): Promise<Map<string, number>> {
    const breakdown = await this.incomeBreakdownByMonth(userId, userCurrency, months);
    return new Map([...breakdown].map(([month, v]) => [month, v.received + v.expected]));
  }

  /** What a single month earned. */
  async incomeInMonth(userId: string, userCurrency: string, month: string): Promise<number> {
    return (await this.incomeByMonth(userId, userCurrency, [month])).get(month) ?? 0;
  }

  /** Monthly run rate across every active stream, in the user's base currency. */
  async monthlyTotal(userId: string, userCurrency: string): Promise<number> {
    // A run rate is what you earn *now*, so a source only counts while it is
    // running: `isActive` is the manual pause, and the date window is the
    // factual one. Without the window an ended job would be counted forever —
    // a user who records the end date of a contract would watch their income
    // stay flat and their savings rate stay wrong.
    const today = fromIsoDate(todayIso());
    const sources = await this.prisma.incomeSource.findMany({
      where: {
        userId,
        deletedAt: null,
        isActive: true,
        startDate: { lte: today },
        OR: [{ endDate: null }, { endDate: { gte: today } }],
      },
    });

    let total = 0;
    for (const source of sources) {
      const monthly = toMonthlyMinor(toNumber(source.amountMinor), source.frequency);
      total += await this.currency.convertForDisplay(monthly, source.currency, userCurrency);
    }
    return total;
  }
}
