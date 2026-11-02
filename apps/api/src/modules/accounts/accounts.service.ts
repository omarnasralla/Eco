import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AccountDto,
  AccountInput,
  AccountsSummaryDto,
  ReconcileAccountInput,
  ReconciliationDto,
  UpdateAccountInput,
} from '@eco/shared';
import { RECONCILIATION_CATEGORY } from '@eco/shared';
import type { FinancialAccount } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import type { BalanceAnchorDto } from '@eco/shared';
import { fromIsoDate, requireIsoDate, todayIso } from '../../common/utils/dates';

function toDto(
  account: FinancialAccount,
  balanceMinor: number,
  movements: number,
  anchor: BalanceAnchorDto | null = null,
): AccountDto {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind as AccountDto['kind'],
    currency: account.currency,
    openingBalanceMinor: toNumber(account.openingBalanceMinor),
    openingBalanceDate: account.openingBalanceDate.toISOString().slice(0, 10),
    balanceMinor,
    movementCount: movements,
    isPrimary: account.isPrimary,
    updatedAt: account.updatedAt.toISOString(),
    createdAt: account.createdAt.toISOString(),
    balanceCardLast4: account.balanceCardLast4,
    anchor,
  };
}

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  async findAll(userId: string): Promise<AccountDto[]> {
    const accounts = await this.prisma.financialAccount.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    return Promise.all(accounts.map((account) => this.withBalance(account)));
  }

  /**
   * The live balance: the opening figure plus everything assigned to the
   * account since that date.
   *
   * Computed on read rather than kept as a running total. A stored total has to
   * be adjusted on every create, edit and delete, and any missed path leaves it
   * quietly wrong for good; deriving it means an edited expense moves the
   * balance by exactly what it moved it by, and a deleted one un-moves it.
   *
   * Sums are grouped by currency in the database and converted once per
   * currency rather than once per row. Cross-currency movements convert at
   * today's rate, not the transaction's: a balance is a position held now, and
   * what a past purchase would be worth today is the honest way to express a
   * foreign-currency movement inside an account denominated in something else.
   * The overwhelmingly common case — spending from an account in its own
   * currency — needs no conversion at all.
   */
  private async withBalance(account: FinancialAccount): Promise<AccountDto> {
    const { net, count } = await this.movementsSince(account);
    const computed = toNumber(account.openingBalanceMinor) + net;
    if (!account.balanceCardLast4) return toDto(account, computed, count);

    // The newest balance this card's bank has stated. Ordered the same way the
    // chain is read, so "newest" cannot disagree between the two screens.
    const latest = await this.prisma.balanceCheckpoint.findFirst({
      where: { userId: account.userId, cardLast4: account.balanceCardLast4 },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
    });
    // Linked, but that card has never stated one. The computed figure is all
    // there is, and claiming an anchor that does not exist would be worse.
    if (!latest) return toDto(account, computed, count);

    // Everything up to and including the message's date is already inside the
    // figure the bank stated, so only the day AFTER it onwards is applied. A
    // movement recorded later on the same day is the known imprecision here:
    // expenses carry a date, not a time, so there is nothing to order them by
    // within the day. The next alert corrects it.
    const dayAfter = new Date(latest.occurredOn);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    const since = await this.movementsSince(account, dayAfter);

    const statedInAccountCurrency =
      latest.currency === account.currency
        ? toNumber(latest.statedBalanceMinor)
        : await this.currency.convert(
            toNumber(latest.statedBalanceMinor),
            latest.currency,
            account.currency,
            todayIso(),
          );

    return toDto(account, statedInAccountCurrency + since.net, count, {
      cardLast4: latest.cardLast4,
      statedBalanceMinor: statedInAccountCurrency,
      asOf: requireIsoDate(latest.occurredOn),
      movementsSinceMinor: since.net,
      // Kept rather than discarded: the distance between the two is how much
      // the movements are missing, and that is a finding, not noise to hide.
      computedBalanceMinor: computed,
    });
  }

  /**
   * The net effect of everything assigned to the account since its opening
   * date, in the account's own currency.
   *
   * Sums are grouped by currency in the database and converted once per
   * currency rather than once per row. Cross-currency movements convert at
   * today's rate, not the transaction's: a balance is a position held now, so
   * what a foreign-currency purchase is worth today is the honest way to
   * express it inside an account denominated in something else. The
   * overwhelmingly common case — spending from an account in its own currency
   * — needs no conversion at all.
   */
  private async movementsSince(
    account: FinancialAccount,
    from?: Date,
  ): Promise<{ net: number; count: number }> {
    const since = from ?? account.openingBalanceDate;

    const [spent, received, contributed, repaid, sentOut, arrived, arrivedUnstated] =
      await Promise.all([
      this.prisma.expense.groupBy({
        by: ['currency'],
        where: { accountId: account.id, deletedAt: null, date: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.incomeReceipt.groupBy({
        by: ['currency'],
        where: { accountId: account.id, date: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Paying into a savings goal moves money out of the account rather than
      // spending it. Without this the same money sits in cash and in savings at
      // once, and net worth — cash plus savings — counts it twice.
      //
      // Contributions are signed, so a withdrawal from a goal is negative and
      // the same subtraction returns the money to the account.
      this.prisma.goalContribution.groupBy({
        by: ['currency'],
        where: { accountId: account.id, date: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // A debt payment moves money out the same way an expense does. The full
      // amount paid, not just the principal portion — both principal and
      // interest left this account, and the split between them is a fact about
      // the debt, not about how much cash you no longer have.
      this.prisma.debtPayment.groupBy({
        by: ['currency'],
        where: { accountId: account.id, date: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Money moved to another account the user owns. It is not spending, so
      // it is not an expense — but it did leave this account, so a balance
      // that ignored it would show a wallet's float still sitting in the bank
      // account that funded it.
      this.prisma.transfer.groupBy({
        by: ['currency'],
        where: { fromAccountId: account.id, deletedAt: null, occurredOn: { gte: since } },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Arriving from one. Grouped on `receivedCurrency` because what matters
      // on this side is what landed, not what was sent: a top-up leaves in
      // dollars and arrives in riyals, and the riyals are what this account
      // can now spend.
      this.prisma.transfer.groupBy({
        by: ['receivedCurrency'],
        where: { toAccountId: account.id, deletedAt: null, occurredOn: { gte: since } },
        _sum: { receivedMinor: true },
        _count: { _all: true },
      }),
      // The incoming transfers whose arriving amount nobody stated. Converted
      // from what was sent, which is the best available answer and visibly a
      // derived one.
      this.prisma.transfer.groupBy({
        by: ['currency'],
        where: {
          toAccountId: account.id,
          deletedAt: null,
          occurredOn: { gte: since },
          receivedMinor: null,
        },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
    ]);

    // `arrived` is keyed on receivedCurrency and receivedMinor; every other
    // group is keyed on currency and amountMinor. Normalised here so the one
    // conversion loop below can read them all the same way.
    const arrivedRows = arrived
      .filter((row) => row.receivedCurrency !== null)
      .map((row) => ({
        currency: row.receivedCurrency as string,
        _sum: { amountMinor: row._sum.receivedMinor },
        _count: row._count,
      }));

    let net = 0;
    let count = 0;
    for (const [rows, sign] of [
      [spent, -1],
      [received, 1],
      [contributed, -1],
      [repaid, -1],
      [sentOut, -1],
      [arrivedRows, 1],
      [arrivedUnstated, 1],
    ] as const) {
      for (const row of rows) {
        count += row._count._all;
        const amount = toNumber(row._sum.amountMinor ?? BigInt(0));
        net +=
          sign *
          (row.currency === account.currency
            ? amount
            : await this.currency.convertForDisplay(amount, row.currency, account.currency));
      }
    }
    return { net, count };
  }

  /**
   * Every balance in the user's base currency.
   *
   * Converted per account rather than summed raw: accounts can be held in
   * different currencies, and adding a riyal balance to a dollar one produces a
   * number that is money in neither. An account whose currency has no rate is
   * counted separately and reported, not folded in at face value.
   */
  async summary(userId: string, userCurrency: string): Promise<AccountsSummaryDto> {
    const accounts = await this.findAll(userId);

    const needsRates = accounts.some((a) => a.currency !== userCurrency);
    // Fetched once rather than per account: a user with six accounts should
    // not cause six lookups of the same day's table.
    const rates = needsRates ? (await this.currency.getRates()).rates : {};

    let totalMinor = 0;
    let unconvertedCount = 0;
    for (const account of accounts) {
      if (account.currency === userCurrency) {
        totalMinor += account.balanceMinor;
        continue;
      }
      // convertForDisplay falls back to face value when no rate exists, which
      // here would quietly add riyals to dollars. A headline balance is the
      // wrong place for that fallback, so a missing rate is reported instead.
      if (rates[account.currency] === undefined) {
        unconvertedCount += 1;
        continue;
      }
      totalMinor += await this.currency.convertForDisplay(
        account.balanceMinor,
        account.currency,
        userCurrency,
      );
    }

    return { totalMinor, currency: userCurrency, unconvertedCount, accounts };
  }

  async findOne(userId: string, id: string): Promise<AccountDto> {
    const account = await this.prisma.financialAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Account not found');
    return this.withBalance(account);
  }

  async create(userId: string, input: AccountInput): Promise<AccountDto> {
    const account = await this.prisma.$transaction(async (tx) => {
      // Exactly one primary account, so the dashboard has an unambiguous
      // "your main account" to point at.
      if (input.isPrimary) {
        await tx.financialAccount.updateMany({
          where: { userId, deletedAt: null },
          data: { isPrimary: false },
        });
      }
      const isFirst =
        (await tx.financialAccount.count({ where: { userId, deletedAt: null } })) === 0;
      return tx.financialAccount.create({
        data: {
          userId,
          name: input.name,
          kind: input.kind,
          currency: input.currency,
          openingBalanceMinor: BigInt(input.balanceMinor),
          openingBalanceDate: input.openingBalanceDate
            ? fromIsoDate(input.openingBalanceDate)
            : new Date(),
          balanceCardLast4: input.balanceCardLast4 ?? null,
          // The first account is primary whether or not the box was ticked:
          // one account and no primary is a state with no useful meaning.
          isPrimary: input.isPrimary || isFirst,
        },
      });
    });

    await this.redis.invalidateUser(userId);
    return this.withBalance(account);
  }

  async update(userId: string, id: string, input: UpdateAccountInput): Promise<AccountDto> {
    const existing = await this.prisma.financialAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Account not found');

    const account = await this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.financialAccount.updateMany({
          where: { userId, deletedAt: null, id: { not: id } },
          data: { isPrimary: false },
        });
      }
      return tx.financialAccount.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.currency !== undefined ? { currency: input.currency } : {}),
          // A balance sent with a date and a balance sent alone are different
          // statements, and conflating them produced a nonsense figure:
          // back-dating to "0 as of 1 August" was read as "it is 0 now" and
          // solved the opening to minus the month's income.
          //
          //   with a date — "on that day it was X" — X is the opening itself
          //   without one — "it is X now"        — solve for the opening that
          //                                        makes today's figure X
          ...(input.openingBalanceDate !== undefined
            ? { openingBalanceDate: fromIsoDate(input.openingBalanceDate) }
            : {}),
          ...(input.balanceMinor !== undefined
            ? {
                openingBalanceMinor: BigInt(
                  input.openingBalanceDate !== undefined
                    ? input.balanceMinor
                    : await this.openingFor(existing, input.balanceMinor),
                ),
              }
            : {}),
          ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
          // `null` unlinks and goes back to computing, which is a different
          // instruction from not mentioning the field at all — so undefined is
          // the only value that leaves the link alone.
          ...(input.balanceCardLast4 !== undefined
            ? { balanceCardLast4: input.balanceCardLast4 ?? null }
            : {}),
        },
      });
    });

    await this.redis.invalidateUser(userId);
    return this.withBalance(account);
  }

  /**
   * The opening figure that makes the derived balance equal what the user just
   * said the balance is.
   *
   * Setting a balance is a reconciliation — "the bank says it is this" — so it
   * has to land on that number exactly. Moving the opening *date* to today
   * cannot achieve that: a transaction dated today would still be counted on
   * top of the correction, so reconciling to 500 after spending 30 today read
   * 470. Solving for the opening instead keeps every movement in the ledger and
   * still lands on the stated figure, and leaves `openingBalanceMinor` meaning
   * exactly what it says — the balance as at the opening date.
   */
  private async openingFor(account: FinancialAccount, targetMinor: number): Promise<number> {
    const { net } = await this.movementsSince(account);
    return targetMinor - net;
  }

  /**
   * Reconcile an account against money counted by hand.
   *
   * The difference between what you counted and what the ledger derives is
   * recorded as a transaction — a shortfall as an expense, a surplus as a
   * one-off receipt — so the balance lands on the counted figure *and* the gap
   * stays visible as money that moved.
   *
   * This is the honest sibling of `update({ balanceMinor })`, which reaches the
   * same balance by solving backwards for the opening figure. That is right
   * when the opening figure was simply wrong; it is wrong when cash actually
   * went somewhere, because the spending disappears from every total that is
   * supposed to explain where the money went.
   *
   * The correction is an ordinary transaction on purpose. It is assigned to the
   * account, dated, and counted by budgets, cash flow and the dashboard exactly
   * like any other — an unexplained £40 is still £40 you no longer have.
   */
  async reconcile(
    userId: string,
    id: string,
    input: ReconcileAccountInput,
    userCurrency: string,
  ): Promise<ReconciliationDto> {
    const account = await this.prisma.financialAccount.findFirst({
      where: { id, userId, deletedAt: null },
    });
    if (!account) throw new NotFoundException('Account not found');

    const date = input.date ?? todayIso();
    // A correction dated before the opening figure is not a movement since that
    // figure, so `movementsSince` would not count it and the balance would not
    // land on what was counted. Refusing is the only honest answer: silently
    // moving the date would record the money on a day it did not move.
    if (date < requireIsoDate(account.openingBalanceDate)) {
      throw new BadRequestException(
        `That date is before this account's opening balance date (${requireIsoDate(
          account.openingBalanceDate,
        )}). Count it on or after that day, or change the opening balance instead.`,
      );
    }

    const { net } = await this.movementsSince(account);
    const previousBalanceMinor = toNumber(account.openingBalanceMinor) + net;
    const differenceMinor = input.actualBalanceMinor - previousBalanceMinor;

    const settled = async (
      outcome: ReconciliationDto['outcome'],
      expenseId: string | null,
      receiptId: string | null,
    ): Promise<ReconciliationDto> => {
      await this.redis.invalidateUser(userId);
      return {
        outcome,
        differenceMinor,
        currency: account.currency,
        previousBalanceMinor,
        date,
        expenseId,
        receiptId,
        account: await this.withBalance(account),
      };
    };

    // Nothing to record. Writing a zero-amount row to mark the occasion would
    // put a transaction in the ledger that moved no money.
    if (differenceMinor === 0) return settled('MATCHED', null, null);

    const amountMinor = Math.abs(differenceMinor);
    // Denominated in the account's own currency, which is what was counted.
    // Every aggregate sums the base figure, so it is frozen at the rate for the
    // day of the count, exactly as a manually entered transaction would be.
    const baseAmountMinor = await this.currency.convert(
      amountMinor,
      account.currency,
      userCurrency,
      date,
    );
    const note = input.notes?.trim() || null;

    if (differenceMinor < 0) {
      const categoryId = await this.reconciliationCategoryId(userId);
      const expense = await this.prisma.expense.create({
        data: {
          userId,
          categoryId,
          accountId: account.id,
          amountMinor: BigInt(amountMinor),
          currency: account.currency,
          baseAmountMinor: BigInt(baseAmountMinor),
          date: fromIsoDate(date),
          merchant: `Reconciled ${account.name}`,
          notes: note,
        },
      });
      return settled('SHORTFALL', expense.id, null);
    }

    const receipt = await this.prisma.incomeReceipt.create({
      data: {
        userId,
        // No schedule produced this, so no source. Inventing one would make a
        // one-off into a recurring rate and inflate every forward projection.
        incomeSourceId: null,
        name: `Reconciled ${account.name}`,
        accountId: account.id,
        amountMinor: BigInt(amountMinor),
        currency: account.currency,
        baseAmountMinor: BigInt(baseAmountMinor),
        date: fromIsoDate(date),
        notes: note,
      },
    });
    return settled('SURPLUS', null, receipt.id);
  }

  /**
   * The user's reconciliation category, created on first use.
   *
   * Not seeded at registration: most users never reconcile, and an unused
   * category in every expense picker is clutter earned by nobody. Matched by
   * slug rather than name so a rename does not orphan it and produce a second.
   */
  private async reconciliationCategoryId(userId: string): Promise<string> {
    const existing = await this.prisma.category.findFirst({
      where: { userId, slug: RECONCILIATION_CATEGORY.slug, deletedAt: null },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await this.prisma.category.create({
      data: {
        userId,
        slug: RECONCILIATION_CATEGORY.slug,
        name: RECONCILIATION_CATEGORY.name,
        icon: RECONCILIATION_CATEGORY.icon,
        color: RECONCILIATION_CATEGORY.color,
        // System, so it cannot be deleted out from under the rows that point at
        // it; `onDelete: Restrict` on the relation would refuse anyway.
        isSystem: true,
        // Unaccounted money is not an essential cost, and counting it as one
        // would inflate the emergency-fund target.
        isEssential: false,
        sortOrder: 99,
      },
      select: { id: true },
    });
    return created.id;
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.prisma.financialAccount.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date(), isPrimary: false },
    });
    if (count === 0) throw new NotFoundException('Account not found');

    // Deleting the primary leaves no primary, so the oldest survivor takes it.
    const remaining = await this.prisma.financialAccount.findFirst({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (remaining && !remaining.isPrimary) {
      await this.prisma.financialAccount.update({
        where: { id: remaining.id },
        data: { isPrimary: true },
      });
    }

    await this.redis.invalidateUser(userId);
  }

  /** Total cash in the base currency, for the dashboard's net worth. */
  async totalBalance(userId: string, userCurrency: string): Promise<number> {
    const { totalMinor } = await this.summary(userId, userCurrency);
    return totalMinor;
  }
}
