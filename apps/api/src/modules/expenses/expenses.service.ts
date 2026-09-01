import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ExpenseDto, ExpenseInput, ExpenseQuery, Paginated } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate } from '../../common/utils/dates';

type ExpenseRow = Prisma.ExpenseGetPayload<{
  include: { category: { select: { id: true; name: true; icon: true; color: true } } };
}>;

function toDto(expense: ExpenseRow): ExpenseDto {
  return {
    id: expense.id,
    amountMinor: toNumber(expense.amountMinor),
    currency: expense.currency,
    baseAmountMinor: toNumber(expense.baseAmountMinor),
    categoryId: expense.categoryId,
    category: expense.category ?? undefined,
    date: requireIsoDate(expense.date),
    merchant: expense.merchant,
    notes: expense.notes,
    isRecurring: expense.isRecurring,
    recurringFrequency: expense.recurringFrequency,
    tags: expense.tags,
    createdAt: expense.createdAt.toISOString(),
    updatedAt: expense.updatedAt.toISOString(),
  };
}

/** Opaque keyset cursor: `<iso date>|<id>`, base64url encoded. */
function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { date: Date; id: string } | null {
  try {
    const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!date || !id) return null;
    return { date: new Date(date), id };
  } catch {
    return null;
  }
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * Keyset pagination, not OFFSET.
   *
   * A user with three years of history has tens of thousands of rows; OFFSET
   * makes page 200 scan every row before it, and it silently skips or repeats
   * items when a new expense is inserted mid-scroll. A cursor on
   * (date, id) — which matches the covering index — is O(log n) at any depth
   * and stable under concurrent writes.
   */
  async findAll(
    userId: string,
    query: ExpenseQuery,
    userCurrency: string,
  ): Promise<Paginated<ExpenseDto>> {
    const where: Prisma.ExpenseWhereInput = {
      userId,
      deletedAt: null,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: fromIsoDate(query.from) } : {}),
              ...(query.to ? { lte: fromIsoDate(query.to) } : {}),
            },
          }
        : {}),
      ...(query.merchant ? { merchant: { contains: query.merchant, mode: 'insensitive' } } : {}),
      ...(query.minAmountMinor != null || query.maxAmountMinor != null
        ? {
            baseAmountMinor: {
              ...(query.minAmountMinor != null ? { gte: BigInt(query.minAmountMinor) } : {}),
              ...(query.maxAmountMinor != null ? { lte: BigInt(query.maxAmountMinor) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { merchant: { contains: query.search, mode: 'insensitive' } },
              { notes: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // Cursor pagination only applies to the default date ordering; the other
    // sorts fall back to offset, which is acceptable because they are used for
    // small filtered views rather than infinite scroll.
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor && query.sort === 'date') {
      const comparator = query.order === 'desc' ? 'lt' : 'gt';
      where.AND = [
        {
          OR: [
            { date: { [comparator]: cursor.date } },
            { date: cursor.date, id: { [comparator]: cursor.id } },
          ],
        },
      ];
    }

    const orderBy: Prisma.ExpenseOrderByWithRelationInput[] =
      query.sort === 'amount'
        ? [{ baseAmountMinor: query.order }, { id: query.order }]
        : query.sort === 'merchant'
          ? [{ merchant: query.order }, { id: query.order }]
          : [{ date: query.order }, { id: query.order }];

    // Fetch one extra row to learn whether another page exists, without a
    // second COUNT query on every scroll.
    const rows = await this.prisma.expense.findMany({
      where,
      orderBy,
      take: query.limit + 1,
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    });

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];

    return {
      items: items.map(toDto),
      nextCursor: hasMore && last ? encodeCursor(last.date, last.id) : null,
    };
  }

  async findOne(userId: string, id: string): Promise<ExpenseDto> {
    const expense = await this.prisma.expense.findFirst({
      where: { id, userId, deletedAt: null },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    return toDto(expense);
  }

  async create(userId: string, input: ExpenseInput, userCurrency: string): Promise<ExpenseDto> {
    await this.assertCategoryOwned(userId, input.categoryId);

    // Convert at the transaction date's rate and freeze it on the row. Every
    // dashboard aggregate sums baseAmountMinor, so this is what keeps totals
    // computable in one indexed scan instead of N conversions per request.
    const baseAmountMinor = await this.currency.convert(
      input.amountMinor,
      input.currency,
      userCurrency,
      input.date,
    );

    const expense = await this.prisma.expense.create({
      data: {
        userId,
        categoryId: input.categoryId,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        baseAmountMinor: BigInt(baseAmountMinor),
        date: fromIsoDate(input.date),
        merchant: input.merchant ?? null,
        notes: input.notes ?? null,
        isRecurring: input.isRecurring,
        recurringFrequency: input.recurringFrequency ?? null,
        tags: input.tags,
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    });

    await this.redis.invalidateUser(userId);
    return toDto(expense);
  }

  async update(
    userId: string,
    id: string,
    input: Partial<ExpenseInput>,
    userCurrency: string,
  ): Promise<ExpenseDto> {
    const existing = await this.prisma.expense.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Expense not found');
    if (input.categoryId) await this.assertCategoryOwned(userId, input.categoryId);

    // Re-derive the base amount whenever amount, currency or date moves —
    // any of the three changes what the transaction was worth.
    const needsReconversion =
      input.amountMinor !== undefined || input.currency !== undefined || input.date !== undefined;

    const baseAmountMinor = needsReconversion
      ? await this.currency.convert(
          input.amountMinor ?? toNumber(existing.amountMinor),
          input.currency ?? existing.currency,
          userCurrency,
          input.date ?? requireIsoDate(existing.date),
        )
      : undefined;

    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(baseAmountMinor !== undefined ? { baseAmountMinor: BigInt(baseAmountMinor) } : {}),
        ...(input.date !== undefined ? { date: fromIsoDate(input.date) } : {}),
        ...(input.merchant !== undefined ? { merchant: input.merchant } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isRecurring !== undefined ? { isRecurring: input.isRecurring } : {}),
        ...(input.recurringFrequency !== undefined
          ? { recurringFrequency: input.recurringFrequency }
          : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    });

    await this.redis.invalidateUser(userId);
    return toDto(expense);
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.expense.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Expense not found');
    await this.redis.invalidateUser(userId);
  }

  /** Bulk import from a CSV upload or a bank export. */
  async createMany(
    userId: string,
    inputs: ExpenseInput[],
    userCurrency: string,
  ): Promise<{ created: number }> {
    const categoryIds = [...new Set(inputs.map((i) => i.categoryId))];
    const owned = await this.prisma.category.count({
      where: { id: { in: categoryIds }, userId, deletedAt: null },
    });
    if (owned !== categoryIds.length) {
      throw new NotFoundException('One or more categories were not found');
    }

    const rows = await Promise.all(
      inputs.map(async (input) => ({
        userId,
        categoryId: input.categoryId,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        baseAmountMinor: BigInt(
          await this.currency.convert(input.amountMinor, input.currency, userCurrency, input.date),
        ),
        date: fromIsoDate(input.date),
        merchant: input.merchant ?? null,
        notes: input.notes ?? null,
        isRecurring: input.isRecurring,
        recurringFrequency: input.recurringFrequency ?? null,
        tags: input.tags,
      })),
    );

    const { count } = await this.prisma.expense.createMany({ data: rows });
    await this.redis.invalidateUser(userId);
    return { created: count };
  }

  private async assertCategoryOwned(userId: string, categoryId: string): Promise<void> {
    const exists = await this.prisma.category.count({
      where: { id: categoryId, userId, deletedAt: null },
    });
    if (exists === 0) throw new NotFoundException('Category not found');
  }
}
