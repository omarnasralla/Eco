import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  MarkPurchasedInput,
  PlannedPurchaseDto,
  PlannedPurchaseInput,
  PlannedPurchasesDto,
  UpdatePlannedPurchaseInput,
} from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate } from '../../common/utils/dates';

type Row = {
  id: string;
  name: string;
  amountMinor: bigint;
  currency: string;
  month: Date;
  categoryId: string | null;
  excludeFromBudget: boolean;
  notes: string | null;
  purchasedExpenseId: string | null;
  purchasedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  category: { name: string } | null;
};

/**
 * Purchases you intend to make in a given month, kept out of that month's
 * budget on purpose.
 *
 * The distinction that matters: this records a *decision*, not a transaction.
 * Nothing here moves a balance, changes net worth, or counts as spending until
 * the purchase actually happens — treating intentions as money already gone is
 * how a planner becomes a source of false alarm and stops being read.
 *
 * What it does do is carry the exclusion forward. `excludedFromBudget` already
 * existed on an expense, but only as something to remember to tick weeks after
 * deciding; linking a plan to the expense it became applies it automatically.
 */
@Injectable()
export class PlannedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * A month's plan.
   *
   * Cancelled items are returned rather than hidden: a plan you abandoned is
   * part of how the month went, and a list that silently loses rows invites
   * the question "did I delete that or did it vanish?".
   */
  async list(userId: string, userCurrency: string, month: string): Promise<PlannedPurchasesDto> {
    const first = firstOfMonth(month);
    const rows = await this.prisma.plannedPurchase.findMany({
      where: { userId, month: first },
      include: { category: { select: { name: true } } },
      orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }],
    });

    const items: PlannedPurchaseDto[] = [];
    let outstanding = 0;
    let purchased = 0;
    let outsideBudget = 0;

    for (const row of rows) {
      const amount = toNumber(row.amountMinor);
      // Converted at the month's own start rather than today, so a plan's
      // total does not drift with the exchange rate while it sits there.
      const base =
        row.currency === userCurrency
          ? amount
          : await this.currency.convert(amount, row.currency, userCurrency, requireIsoDate(first));

      const dto = toDto(row, base);
      items.push(dto);

      if (dto.status === 'PURCHASED') purchased += base;
      else if (dto.status === 'PLANNED') {
        outstanding += base;
        if (row.excludeFromBudget) outsideBudget += base;
      }
    }

    return {
      month: requireIsoDate(first),
      items,
      outstandingMinor: outstanding,
      purchasedMinor: purchased,
      outsideBudgetMinor: outsideBudget,
      currency: userCurrency,
    };
  }

  async create(
    userId: string,
    userCurrency: string,
    input: PlannedPurchaseInput,
  ): Promise<PlannedPurchaseDto> {
    if (input.categoryId) await this.assertCategoryOwned(userId, input.categoryId);

    const row = await this.prisma.plannedPurchase.create({
      data: {
        userId,
        name: input.name,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        month: firstOfMonth(input.month),
        categoryId: input.categoryId ?? null,
        excludeFromBudget: input.excludeFromBudget,
        notes: input.notes?.trim() || null,
      },
      include: { category: { select: { name: true } } },
    });
    await this.redis.invalidateUser(userId);
    return toDto(row, await this.toBase(row, userCurrency));
  }

  async update(
    userId: string,
    id: string,
    userCurrency: string,
    input: UpdatePlannedPurchaseInput,
  ): Promise<PlannedPurchaseDto> {
    await this.require(userId, id);
    if (input.categoryId) await this.assertCategoryOwned(userId, input.categoryId);

    const row = await this.prisma.plannedPurchase.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.month !== undefined ? { month: firstOfMonth(input.month) } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId ?? null } : {}),
        ...(input.excludeFromBudget !== undefined
          ? { excludeFromBudget: input.excludeFromBudget }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      include: { category: { select: { name: true } } },
    });
    await this.redis.invalidateUser(userId);
    return toDto(row, await this.toBase(row, userCurrency));
  }

  /**
   * Mark a plan bought, optionally naming the expense it became.
   *
   * Linking the expense is what makes planning worth the effort: the
   * exclusion decided weeks ago is applied to the real row now, rather than
   * depending on someone remembering a checkbox at the till.
   */
  async markPurchased(
    userId: string,
    id: string,
    userCurrency: string,
    input: MarkPurchasedInput,
  ): Promise<PlannedPurchaseDto> {
    const planned = await this.require(userId, id);

    if (input.expenseId) {
      const expense = await this.prisma.expense.findFirst({
        where: { id: input.expenseId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!expense) throw new NotFoundException('Expense not found');

      if (planned.excludeFromBudget) {
        await this.prisma.expense.update({
          where: { id: expense.id },
          data: { excludedFromBudget: true },
        });
      }
    }

    const row = await this.prisma.plannedPurchase.update({
      where: { id },
      data: {
        purchasedAt: new Date(),
        cancelledAt: null,
        purchasedExpenseId: input.expenseId ?? null,
      },
      include: { category: { select: { name: true } } },
    });
    await this.redis.invalidateUser(userId);
    return toDto(row, await this.toBase(row, userCurrency));
  }

  /** Abandoned, not deleted — a month's plan should still read truthfully. */
  async cancel(userId: string, id: string, userCurrency: string): Promise<PlannedPurchaseDto> {
    await this.require(userId, id);
    const row = await this.prisma.plannedPurchase.update({
      where: { id },
      data: { cancelledAt: new Date(), purchasedAt: null },
      include: { category: { select: { name: true } } },
    });
    await this.redis.invalidateUser(userId);
    return toDto(row, await this.toBase(row, userCurrency));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.require(userId, id);
    await this.prisma.plannedPurchase.delete({ where: { id } });
    await this.redis.invalidateUser(userId);
  }

  private async require(userId: string, id: string) {
    const row = await this.prisma.plannedPurchase.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Planned purchase not found');
    return row;
  }

  private async assertCategoryOwned(userId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');
  }

  private async toBase(row: { amountMinor: bigint; currency: string; month: Date }, base: string) {
    const amount = toNumber(row.amountMinor);
    if (row.currency === base) return amount;
    return this.currency.convert(amount, row.currency, base, requireIsoDate(row.month));
  }
}

function toDto(row: Row, baseAmountMinor: number): PlannedPurchaseDto {
  return {
    id: row.id,
    name: row.name,
    amountMinor: toNumber(row.amountMinor),
    currency: row.currency,
    baseAmountMinor,
    month: requireIsoDate(row.month),
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    excludeFromBudget: row.excludeFromBudget,
    notes: row.notes,
    // Derived rather than stored, so a row records when it happened and not
    // merely that it did.
    status: row.cancelledAt ? 'CANCELLED' : row.purchasedAt ? 'PURCHASED' : 'PLANNED',
    purchasedExpenseId: row.purchasedExpenseId,
    purchasedAt: row.purchasedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Any date inside a month, normalised to its first day. */
function firstOfMonth(date: string): Date {
  return fromIsoDate(`${date.slice(0, 7)}-01`);
}
