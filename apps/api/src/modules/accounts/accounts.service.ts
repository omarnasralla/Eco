import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AccountDto,
  AccountInput,
  AccountsSummaryDto,
  BalanceCountDto,
  ReconcileAccountInput,
  ReconciliationDto,
  UpdateAccountInput,
} from '@eco/shared';
import type { BalanceCount, FinancialAccount } from '@prisma/client';
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
  reservedMinor: number,
  anchor: BalanceAnchorDto | null = null,
  count: BalanceCountDto | null = null,
): AccountDto {
  return {
    id: account.id,
    name: account.name,
    kind: account.kind as AccountDto['kind'],
    currency: account.currency,
    openingBalanceMinor: toNumber(account.openingBalanceMinor),
    openingBalanceDate: account.openingBalanceDate.toISOString().slice(0, 10),
    balanceMinor,
    reservedMinor,
    availableMinor: balanceMinor - reservedMinor,
    movementCount: movements,
    isPrimary: account.isPrimary,
    updatedAt: account.updatedAt.toISOString(),
    createdAt: account.createdAt.toISOString(),
    balanceCardLast4: account.balanceCardLast4,
    alertChannel: account.alertChannel,
    alertAliases: account.alertAliases,
    anchor,
    count,
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
    const [{ net, count }, reserved] = await Promise.all([
      this.movementsSince(account),
      this.reservedFor(account),
    ]);
    const computed = toNumber(account.openingBalanceMinor) + net;
    if (!account.balanceCardLast4) {
      const counted = await this.fromLatestCount(account, computed);
      return counted
        ? toDto(account, counted.balanceMinor, count, reserved, null, counted.count)
        : toDto(account, computed, count, reserved);
    }

    // The newest balance this card's bank has stated. Ordered the same way the
    // chain is read, so "newest" cannot disagree between the two screens.
    const latest = await this.prisma.balanceCheckpoint.findFirst({
      where: { userId: account.userId, cardLast4: account.balanceCardLast4 },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
    });
    // Linked, but that card has never stated one. The computed figure is all
    // there is, and claiming an anchor that does not exist would be worse.
    if (!latest) return toDto(account, computed, count, reserved);

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

    return toDto(account, statedInAccountCurrency + since.net, count, reserved, {
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
   * The balance read from the latest hand count, and how far that count was
   * from what the ledger expected.
   *
   * A count is to an account without a bank alert what a bank-stated balance
   * is to one with: the figure it is read from. Everything recorded after the
   * count is applied on top of it, and nothing before it can move it — so
   * finding a missing purchase from last week changes what was unaccounted
   * for, not what is there now, which is exactly what happened.
   *
   * The expected figure is the previous count (or the opening balance) carried
   * forward by what was recorded between the two. The gap between that and
   * what was counted is movements nobody recorded or recorded wrong — not
   * spending, and never booked as any.
   */
  private async fromLatestCount(
    account: FinancialAccount,
    computedMinor: number,
  ): Promise<{ balanceMinor: number; count: BalanceCountDto } | null> {
    const counts = await this.prisma.balanceCount.findMany({
      where: { accountId: account.id },
      orderBy: { countedAt: 'desc' },
      take: 2,
    });
    const [latest, previous] = counts;
    if (!latest) return null;

    const after = (c: BalanceCount) =>
      this.movementsSince(account, c.countedOn, sameDayCutoff(c));
    const sinceLatest = await after(latest);
    // What the account would read now from the previous anchor; less what was
    // recorded after the latest count, that is what the ledger expected then.
    const previousNow = previous
      ? toNumber(previous.countedMinor) + (await after(previous)).net
      : computedMinor;
    const expectedMinor = previousNow - sinceLatest.net;
    const countedMinor = toNumber(latest.countedMinor);

    return {
      balanceMinor: countedMinor + sinceLatest.net,
      count: {
        id: latest.id,
        countedMinor,
        countedOn: requireIsoDate(latest.countedOn),
        countedAt: latest.countedAt.toISOString(),
        note: latest.note,
        movementsSinceMinor: sinceLatest.net,
        unaccountedMinor: countedMinor - expectedMinor,
      },
    };
  }

  /**
   * How much of this account's balance is spoken for by savings goals.
   *
   * Paying into a goal from an account does not move the money: it is still in
   * the account, earning whatever it earns, reachable in an emergency. What
   * changed is that it now has a name on it. So the balance stays whole and
   * the reserved part is reported beside it, and `availableMinor` is what is
   * free to spend.
   *
   * The goal does not add to net worth on top of this, because the same money
   * is already counted here — that is what a contribution's share of the
   * goal's `alreadyCountedMinor` records. Money genuinely moved out of an
   * account belongs in a transfer, which is a different thing and does move
   * the balance.
   *
   * Every contribution counts, not only those since the opening date: a
   * reservation made last year still holds today, whereas a movement before
   * the opening balance is already inside that figure.
   *
   * Only goals that still count hold money aside. A goal that was abandoned or
   * deleted has stopped being a plan, so the money it named is free again, and
   * leaving its reservation standing was its own kind of lie: an account
   * reporting more reserved than every visible goal adds up to, with no way to
   * find the difference. The filter matches `GoalsService.totalSaved`, so one
   * rule decides both what counts as savings and what cash is spoken for.
   * The contribution rows stay either way — they are what happened.
   *
   * Contributions are signed, so taking money back out of a goal reduces the
   * reservation by the same subtraction. The floor at zero keeps a goal whose
   * withdrawals exceed its account-funded payments from reporting a negative
   * reservation, which would read as free money.
   */
  private async reservedFor(account: FinancialAccount): Promise<number> {
    const mine = await this.prisma.goalContribution.groupBy({
      by: ['goalId', 'currency'],
      where: {
        accountId: account.id,
        goal: { deletedAt: null, status: { in: ['ACTIVE', 'ACHIEVED'] } },
      },
      _sum: { amountMinor: true },
    });
    if (mine.length === 0) return 0;

    const goalIds = [...new Set(mine.map((row) => row.goalId))];
    const [goals, funded] = await Promise.all([
      this.prisma.savingsGoal.findMany({
        where: { id: { in: goalIds } },
        select: { id: true, currentAmountMinor: true },
      }),
      // Everything every account has put in, which is what the goal's balance
      // has to be measured against — a goal funded from two accounts cannot be
      // judged from one of them.
      this.prisma.goalContribution.groupBy({
        by: ['goalId'],
        where: { goalId: { in: goalIds }, accountId: { not: null } },
        _sum: { goalAmountMinor: true },
      }),
    ]);

    const heldBy = new Map(goals.map((g) => [g.id, toNumber(g.currentAmountMinor)]));
    const paidInto = new Map(
      funded.map((f) => [f.goalId, toNumber(f._sum.goalAmountMinor ?? BigInt(0))]),
    );

    let reserved = 0;
    for (const row of mine) {
      const amount = toNumber(row._sum.amountMinor ?? BigInt(0));
      const inAccountCurrency =
        row.currency === account.currency
          ? amount
          : await this.currency.convertForDisplay(amount, row.currency, account.currency);

      // A goal cannot hold more aside than it holds at all. Editing a goal's
      // balance down by hand is the ordinary way this happens — the payments
      // that funded it are still on record, so without this the account would
      // go on reserving money the goal no longer claims, and no screen would
      // show where the difference went.
      //
      // The shortfall is shared across the accounts that funded it, in
      // proportion to what each put in: with nothing to say which account the
      // money came back to, taking it from one would be a guess. Taking it
      // back deliberately is what a withdrawal is for, and that names its
      // account.
      const paid = paidInto.get(row.goalId) ?? 0;
      const held = heldBy.get(row.goalId) ?? 0;
      const share = paid > 0 ? Math.min(1, held / paid) : 0;
      reserved += inAccountCurrency * share;
    }
    return Math.max(0, Math.round(reserved));
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
    /**
     * On the `from` day itself, only rows recorded after this moment. A hand
     * count is taken at a time of day, and a coffee bought that afternoon is
     * after it; a bank alert carries only a date, so it passes none.
     */
    recordedAfter?: Date,
  ): Promise<{ net: number; count: number }> {
    const since = from ?? account.openingBalanceDate;
    const on = (field: 'date' | 'occurredOn') =>
      recordedAfter
        ? {
            OR: [
              { [field]: { gt: since } },
              { [field]: since, createdAt: { gt: recordedAfter } },
            ],
          }
        : { [field]: { gte: since } };

    const [spent, received, lentBack, repaid, sentOut, arrived, arrivedUnstated] =
      await Promise.all([
      this.prisma.expense.groupBy({
        by: ['currency'],
        where: { accountId: account.id, deletedAt: null, ...on('date') },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      this.prisma.incomeReceipt.groupBy({
        by: ['currency'],
        where: { accountId: account.id, ...on('date') },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Money coming back from someone you lent to. It arrives in an account
      // like any other credit, and without this it arrived nowhere: the
      // receivable fell by the repayment and no balance rose to meet it, so
      // being paid back made net worth go down.
      this.prisma.receivablePayment.groupBy({
        by: ['currency'],
        where: { accountId: account.id, ...on('date') },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // A debt payment moves money out the same way an expense does. The full
      // amount paid, not just the principal portion — both principal and
      // interest left this account, and the split between them is a fact about
      // the debt, not about how much cash you no longer have.
      this.prisma.debtPayment.groupBy({
        by: ['currency'],
        where: { accountId: account.id, ...on('date') },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Money moved to another account the user owns. It is not spending, so
      // it is not an expense — but it did leave this account, so a balance
      // that ignored it would show a wallet's float still sitting in the bank
      // account that funded it.
      this.prisma.transfer.groupBy({
        by: ['currency'],
        where: { fromAccountId: account.id, deletedAt: null, ...on('occurredOn') },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Arriving from one. Grouped on `receivedCurrency` because what matters
      // on this side is what landed, not what was sent: a top-up leaves in
      // dollars and arrives in riyals, and the riyals are what this account
      // can now spend.
      this.prisma.transfer.groupBy({
        by: ['receivedCurrency'],
        where: { toAccountId: account.id, deletedAt: null, ...on('occurredOn') },
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
          ...on('occurredOn'),
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
      [repaid, -1],
      [lentBack, 1],
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
    let reservedMinor = 0;
    let unconvertedCount = 0;
    for (const account of accounts) {
      if (account.currency === userCurrency) {
        totalMinor += account.balanceMinor;
        reservedMinor += account.reservedMinor;
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
      // Reserved travels with the balance it came out of: an account left out
      // of the total for want of a rate must not contribute its reservation
      // either, or "free to spend" would be reduced by money the total above
      // never included.
      reservedMinor += await this.currency.convertForDisplay(
        account.reservedMinor,
        account.currency,
        userCurrency,
      );
    }

    return {
      totalMinor,
      reservedMinor,
      availableMinor: totalMinor - reservedMinor,
      currency: userCurrency,
      unconvertedCount,
      accounts,
    };
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
          alertChannel: input.alertChannel ?? null,
          alertAliases: input.alertAliases ?? [],
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

    // Once an account is read from a count, solving for the opening figure no
    // longer moves what it shows — the count does. "It is X now" is then just
    // another count, so it is recorded as one.
    const countsAsCount =
      input.balanceMinor !== undefined &&
      input.openingBalanceDate === undefined &&
      !existing.balanceCardLast4 &&
      (await this.prisma.balanceCount.count({ where: { accountId: id } })) > 0;

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
          ...(input.balanceMinor !== undefined && !countsAsCount
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
          ...(input.alertChannel !== undefined
            ? { alertChannel: input.alertChannel || null }
            : {}),
          ...(input.alertAliases !== undefined ? { alertAliases: input.alertAliases } : {}),
        },
      });
    });

    if (countsAsCount) {
      await this.prisma.balanceCount.create({
        data: {
          userId,
          accountId: id,
          countedMinor: BigInt(input.balanceMinor!),
          countedOn: fromIsoDate(todayIso()),
          countedAt: new Date(),
          note: 'Balance set by hand',
        },
      });
    }

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
   * The count is recorded as what the account holds from that moment on — the
   * way a bank-stated balance is — and nothing else is written. The difference
   * from what the ledger held is reported, and stays visible on the account as
   * unaccounted for, but is not booked as spending or income: in practice it
   * was almost never either, but capture errors still waiting to be found.
   * Booked, it sat in the month's budget, and frozen as a row it never shrank
   * once the causes were fixed.
   *
   * This is still the honest sibling of `update({ balanceMinor })`, which
   * rewrites the opening figure and so erases the gap instead of showing it.
   */
  async reconcile(
    userId: string,
    id: string,
    input: ReconcileAccountInput,
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

    // A bank that states its own balance is the better count; a hand count
    // beside it would make two figures the account is read from.
    if (account.balanceCardLast4) {
      throw new BadRequestException(
        `${account.name}'s balance comes from your bank's own alerts for card ···${account.balanceCardLast4}, ` +
          'so there is nothing to count against. Unlink the card to count it by hand.',
      );
    }

    const before = await this.withBalance(account);
    const previousBalanceMinor = before.balanceMinor;
    const differenceMinor = input.actualBalanceMinor - previousBalanceMinor;

    // Counted today means counted now. A count entered for an earlier day has
    // no time of day to go on, so that whole day is taken as inside it.
    const countedAt = date === todayIso() ? new Date() : new Date(`${date}T23:59:59.999Z`);
    const count = await this.prisma.balanceCount.create({
      data: {
        userId,
        accountId: account.id,
        countedMinor: BigInt(input.actualBalanceMinor),
        countedOn: fromIsoDate(date),
        countedAt,
        note: input.notes?.trim() || null,
      },
    });
    await this.redis.invalidateUser(userId);

    return {
      outcome: differenceMinor === 0 ? 'MATCHED' : differenceMinor < 0 ? 'SHORTFALL' : 'SURPLUS',
      differenceMinor,
      currency: account.currency,
      previousBalanceMinor,
      date,
      countId: count.id,
      account: await this.withBalance(account),
    };
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

  /**
   * Money that could be reached today, for the emergency buffer.
   *
   * Every account except investments, whose value is not a sum you can draw on
   * this afternoon without selling something at whatever the market offers.
   *
   * This exists because the buffer used to count savings GOALS alone. Someone
   * holding $4,140 across their accounts and no goal was scored as having 0.0
   * months covered and told to build an emergency fund they already had — the
   * advice was not merely useless, it was wrong. What makes money an emergency
   * buffer is being able to get at it, not having been labelled.
   *
   * Overdrafts subtract: an account in the red is not a place money is kept.
   */
  async liquidBalance(userId: string, userCurrency: string): Promise<number> {
    const accounts = await this.findAll(userId);
    let total = 0;
    for (const account of accounts) {
      if (account.kind === 'INVESTMENT') continue;
      total +=
        account.currency === userCurrency
          ? account.balanceMinor
          : await this.currency.convertForDisplay(
              account.balanceMinor,
              account.currency,
              userCurrency,
            );
    }
    return total;
  }
}

/**
 * The moment after which a same-day movement follows a count — or none, for a
 * count entered against an earlier day, which has no time of day to go on.
 */
function sameDayCutoff(count: BalanceCount): Date | undefined {
  return count.countedAt.toISOString().slice(0, 10) === requireIsoDate(count.countedOn)
    ? count.countedAt
    : undefined;
}
