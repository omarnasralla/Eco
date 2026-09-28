import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ExpenseDto,
  ExpenseInput,
  ExpenseQuery,
  Paginated,
  RenameMerchantInput,
  RenameMerchantResultDto,
} from '@eco/shared';
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
    accountId: expense.accountId,
    date: requireIsoDate(expense.date),
    merchant: expense.merchant,
    notes: expense.notes,
    isRecurring: expense.isRecurring,
    excludedFromBudget: expense.excludedFromBudget,
    needsReview: expense.needsReview,
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
      ...(query.needsReview !== undefined ? { needsReview: query.needsReview } : {}),
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

    // Cursor pagination applies to the two chronological sorts; amount and
    // merchant fall back to offset, which is acceptable because they are used
    // for small filtered views rather than infinite scroll.
    //
    // The cursor carries whichever timestamp the sort is keyed on, so paging
    // and ordering cannot disagree — comparing a createdAt cursor against the
    // date column would skip and repeat rows.
    const timeField = query.sort === 'created' ? 'createdAt' : 'date';
    const chronological = query.sort === 'created' || query.sort === 'date';
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor && chronological) {
      const comparator = query.order === 'desc' ? 'lt' : 'gt';
      where.AND = [
        {
          OR: [
            { [timeField]: { [comparator]: cursor.date } },
            { [timeField]: cursor.date, id: { [comparator]: cursor.id } },
          ],
        },
      ];
    }

    const orderBy: Prisma.ExpenseOrderByWithRelationInput[] =
      query.sort === 'amount'
        ? [{ baseAmountMinor: query.order }, { id: query.order }]
        : query.sort === 'merchant'
          ? [{ merchant: query.order }, { id: query.order }]
          : [{ [timeField]: query.order }, { id: query.order }];

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
      nextCursor:
        hasMore && last ? encodeCursor(last[timeField], last.id) : null,
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

  /**
   * Merchants this user has spent at before, most-used first.
   *
   * Scoped to a category when one is given, because that is what makes the
   * suggestion worth having: "Tes" in Food should offer Tesco, not a lender
   * called Tessa. Falls back to the whole history when no category is chosen
   * yet, so the field is useful before the form is complete.
   *
   * Ordered by how often each name has been used rather than how recently. A
   * frequency ranking puts the weekly shop above the once-visited restaurant,
   * which is the guess more likely to save a keystroke.
   */
  async merchantSuggestions(
    userId: string,
    categoryId?: string,
    search?: string,
    limit = 8,
  ): Promise<string[]> {
    const rows = await this.prisma.expense.groupBy({
      by: ['merchant'],
      where: {
        userId,
        deletedAt: null,
        merchant: {
          not: null,
          ...(search ? { contains: search, mode: 'insensitive' } : {}),
        },
        ...(categoryId ? { categoryId } : {}),
      },
      _count: { merchant: true },
      orderBy: { _count: { merchant: 'desc' } },
      take: limit,
    });

    return rows.map((row) => row.merchant).filter((m): m is string => m !== null && m !== '');
  }

  async create(userId: string, input: ExpenseInput, userCurrency: string): Promise<ExpenseDto> {
    await this.assertCategoryOwned(userId, input.categoryId);
    if (input.accountId) await this.assertAccountOwned(userId, input.accountId);

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
        accountId: input.accountId ?? null,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        baseAmountMinor: BigInt(baseAmountMinor),
        date: fromIsoDate(input.date),
        merchant: input.merchant ?? null,
        notes: input.notes ?? null,
        isRecurring: input.isRecurring,
        excludedFromBudget: input.excludedFromBudget ?? false,
        // A cadence only means something on a row that repeats. Storing one
        // beside isRecurring=false leaves a contradiction for every later
        // reader to resolve, and they will not all resolve it the same way.
        recurringFrequency: input.isRecurring ? (input.recurringFrequency ?? 'MONTHLY') : null,
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
    if (input.accountId) await this.assertAccountOwned(userId, input.accountId);

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
        ...(input.accountId !== undefined ? { accountId: input.accountId ?? null } : {}),
        ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(baseAmountMinor !== undefined ? { baseAmountMinor: BigInt(baseAmountMinor) } : {}),
        ...(input.date !== undefined ? { date: fromIsoDate(input.date) } : {}),
        ...(input.merchant !== undefined ? { merchant: input.merchant } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isRecurring !== undefined ? { isRecurring: input.isRecurring } : {}),
        ...(input.excludedFromBudget !== undefined
          ? { excludedFromBudget: input.excludedFromBudget }
          : {}),
        // Clearing the flag clears the cadence with it, in the same write.
        ...(input.isRecurring === false
          ? { recurringFrequency: null }
          : input.recurringFrequency !== undefined
          ? { recurringFrequency: input.recurringFrequency }
          : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        // Editing a captured row is the confirmation. The flag asks "did the
        // guess land in the right place?", and a person who has just opened
        // the row and saved it has answered — whether they changed the
        // category or decided it was already right. Leaving it set would ask
        // the same question again forever.
        ...(existing.needsReview ? { needsReview: false } : {}),
      },
      include: { category: { select: { id: true, name: true, icon: true, color: true } } },
    });

    await this.redis.invalidateUser(userId);
    return toDto(expense);
  }

  /**
   * Rename a merchant everywhere it appears, optionally recategorising as it goes.
   *
   * Spelling is not something the user controls once capture is automatic: a
   * shop typed as "Nwateh" arrives from the bank as "Nawateh", and the two are
   * separate merchants to every report and to the category inference that
   * makes capture silent. Reconciling them previously meant editing the
   * database by hand.
   *
   * Renaming onto an existing name merges the two, which is the normal case.
   * Matching is case-insensitive but exact — no prefix cleverness here, since
   * this rewrites rows in bulk and the user has named both sides explicitly.
   *
   * Soft-deleted rows are left alone: they are not in any report, and
   * rewriting history the user has already deleted is not this feature's job.
   */
  async renameMerchant(
    userId: string,
    input: RenameMerchantInput,
  ): Promise<RenameMerchantResultDto> {
    const to = input.to.trim();
    if (input.categoryId) await this.assertCategoryOwned(userId, input.categoryId);

    // Whether this is a merge is decided before the write, because afterwards
    // the two are indistinguishable.
    const existing = await this.prisma.expense.count({
      where: {
        userId,
        deletedAt: null,
        merchant: { equals: to, mode: 'insensitive' },
        NOT: { merchant: { equals: input.from.trim(), mode: 'insensitive' } },
      },
    });

    const { count } = await this.prisma.expense.updateMany({
      where: {
        userId,
        deletedAt: null,
        merchant: { equals: input.from.trim(), mode: 'insensitive' },
      },
      data: {
        merchant: to,
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        // A row a human has just deliberately renamed is a row a human has
        // looked at, so it is no longer waiting on review.
        needsReview: false,
      },
    });

    if (count === 0) throw new NotFoundException(`No expenses found for "${input.from}"`);

    // When a category was given, apply it to the rows that already carried the
    // target name too — otherwise a merge leaves the merchant split across two
    // categories, which is the state this was meant to end.
    if (input.categoryId && existing > 0) {
      await this.prisma.expense.updateMany({
        where: { userId, deletedAt: null, merchant: { equals: to, mode: 'insensitive' } },
        data: { categoryId: input.categoryId, needsReview: false },
      });
    }

    const category = input.categoryId
      ? await this.prisma.category.findUnique({
          where: { id: input.categoryId },
          select: { name: true },
        })
      : null;

    await this.redis.invalidateUser(userId);
    return {
      renamed: count,
      merged: existing > 0,
      merchant: to,
      categoryName: category?.name ?? null,
    };
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.expense.updateMany({
      where: { id, userId, deletedAt: null },
      // Clearing externalRef matters: the unique index that makes a retried
      // capture idempotent does not exclude soft-deleted rows, so a deleted
      // row went on owning its reference forever. A later tap carrying that
      // reference collided with a row the user could no longer see, and was
      // answered with "already recorded" — the expense silently never existed.
      // A deleted capture releases its reference.
      data: { deletedAt: new Date(), externalRef: null },
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
        excludedFromBudget: input.excludedFromBudget ?? false,
        // A cadence only means something on a row that repeats. Storing one
        // beside isRecurring=false leaves a contradiction for every later
        // reader to resolve, and they will not all resolve it the same way.
        recurringFrequency: input.isRecurring ? (input.recurringFrequency ?? 'MONTHLY') : null,
        tags: input.tags,
      })),
    );

    const { count } = await this.prisma.expense.createMany({ data: rows });
    await this.redis.invalidateUser(userId);
    return { created: count };
  }

  private async assertAccountOwned(userId: string, accountId: string): Promise<void> {
    const exists = await this.prisma.financialAccount.count({
      where: { id: accountId, userId, deletedAt: null },
    });
    if (exists === 0) throw new NotFoundException('Account not found');
  }

  private async assertCategoryOwned(userId: string, categoryId: string): Promise<void> {
    const exists = await this.prisma.category.count({
      where: { id: categoryId, userId, deletedAt: null },
    });
    if (exists === 0) throw new NotFoundException('Category not found');
  }
}
