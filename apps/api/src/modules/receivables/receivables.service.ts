import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ReceivableDto,
  ReceivableInput,
  ReceivablePaymentInput,
  ReceivablesSummaryDto,
  UpdateReceivableInput,
} from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate, todayIso } from '../../common/utils/dates';

type Row = {
  id: string;
  person: string;
  principalMinor: bigint;
  currency: string;
  lentOn: Date;
  accountId: string | null;
  note: string | null;
  settledAt: Date | null;
  account: { name: string } | null;
  payments: Array<{
    id: string;
    amountMinor: bigint;
    currency: string;
    date: Date;
    accountId: string | null;
    note: string | null;
    account: { name: string } | null;
  }>;
};

function toDto(row: Row): ReceivableDto {
  const principal = toNumber(row.principalMinor);
  // Derived, never stored: an edited or deleted repayment then moves the
  // outstanding figure by exactly what it moved, with no path to miss.
  const repaid = row.payments.reduce((sum, p) => sum + toNumber(p.amountMinor), 0);
  return {
    id: row.id,
    person: row.person,
    principalMinor: principal,
    currency: row.currency,
    lentOn: requireIsoDate(row.lentOn),
    accountId: row.accountId,
    accountName: row.account?.name ?? null,
    note: row.note,
    repaidMinor: repaid,
    // Floored at zero: someone who hands back more than they borrowed has
    // settled it and made a gift, not created a negative loan.
    outstandingMinor: Math.max(principal - repaid, 0),
    repaidPct: principal > 0 ? Math.min(Math.round((repaid / principal) * 1000) / 10, 100) : 0,
    settled: row.settledAt !== null,
    settledAt: row.settledAt?.toISOString() ?? null,
    payments: row.payments.map((p) => ({
      id: p.id,
      amountMinor: toNumber(p.amountMinor),
      currency: p.currency,
      date: requireIsoDate(p.date),
      accountId: p.accountId,
      accountName: p.account?.name ?? null,
      note: p.note,
    })),
  };
}

const INCLUDE = {
  account: { select: { name: true } },
  payments: {
    orderBy: { date: 'asc' as const },
    include: { account: { select: { name: true } } },
  },
};

@Injectable()
export class ReceivablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
  ) {}

  /**
   * Everyone who owes the user money.
   *
   * Settled loans are listed too. A loan that came back is the evidence that
   * lending to this person works out, and hiding it would leave the screen
   * showing only the ones that have not.
   */
  async findAll(userId: string, userCurrency: string): Promise<ReceivablesSummaryDto> {
    const rows = await this.prisma.receivable.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ settledAt: 'asc' }, { lentOn: 'desc' }],
      include: INCLUDE,
    });
    const items = rows.map((row) => toDto(row as Row));

    let outstanding = 0;
    let lent = 0;
    let repaid = 0;
    for (const item of items) {
      const convert = (minor: number) =>
        item.currency === userCurrency
          ? Promise.resolve(minor)
          : this.currency.convertForDisplay(minor, item.currency, userCurrency);
      lent += await convert(item.principalMinor);
      repaid += await convert(item.repaidMinor);
      // A settled loan owes nothing, whatever the arithmetic says: writing one
      // off is a decision, and leaving its remainder in the total would keep
      // counting money the user has decided is gone.
      if (!item.settled) outstanding += await convert(item.outstandingMinor);
    }

    return {
      outstandingMinor: outstanding,
      lentMinor: lent,
      repaidMinor: repaid,
      currency: userCurrency,
      peopleOwing: new Set(
        items.filter((i) => !i.settled && i.outstandingMinor > 0).map((i) => i.person),
      ).size,
      items,
    };
  }

  /** Still owed, in the user's base currency — for net worth. */
  async totalOutstanding(userId: string, userCurrency: string): Promise<number> {
    const rows = await this.prisma.receivable.findMany({
      where: { userId, deletedAt: null, settledAt: null },
      include: INCLUDE,
    });

    let total = 0;
    for (const row of rows) {
      const dto = toDto(row as Row);
      total +=
        dto.currency === userCurrency
          ? dto.outstandingMinor
          : await this.currency.convertForDisplay(
              dto.outstandingMinor,
              dto.currency,
              userCurrency,
            );
    }
    return total;
  }

  async create(userId: string, input: ReceivableInput): Promise<ReceivableDto> {
    const row = await this.prisma.receivable.create({
      data: {
        userId,
        person: input.person,
        principalMinor: BigInt(input.amountMinor),
        currency: input.currency,
        lentOn: fromIsoDate(input.lentOn),
        accountId: input.accountId ?? null,
        note: input.note ?? null,
      },
      include: INCLUDE,
    });
    await this.redis.invalidateUser(userId);
    return toDto(row as Row);
  }

  async update(
    userId: string,
    id: string,
    input: UpdateReceivableInput,
  ): Promise<ReceivableDto> {
    await this.owned(userId, id);
    const row = await this.prisma.receivable.update({
      where: { id },
      data: {
        ...(input.person !== undefined ? { person: input.person } : {}),
        ...(input.amountMinor !== undefined
          ? { principalMinor: BigInt(input.amountMinor) }
          : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.lentOn !== undefined ? { lentOn: fromIsoDate(input.lentOn) } : {}),
        ...(input.accountId !== undefined ? { accountId: input.accountId ?? null } : {}),
        ...(input.note !== undefined ? { note: input.note ?? null } : {}),
        // Settling is a timestamp, not a flag, so a row says WHEN it was
        // called done rather than merely that it was.
        ...(input.settled !== undefined
          ? { settledAt: input.settled ? new Date() : null }
          : {}),
      },
      include: INCLUDE,
    });
    await this.redis.invalidateUser(userId);
    return toDto(row as Row);
  }

  async addPayment(
    userId: string,
    id: string,
    input: ReceivablePaymentInput,
  ): Promise<ReceivableDto> {
    const receivable = await this.owned(userId, id);
    await this.prisma.receivablePayment.create({
      data: {
        userId,
        receivableId: id,
        amountMinor: BigInt(input.amountMinor),
        // Defaults to the loan's own currency: someone repaying in a different
        // one is possible, but the overwhelmingly common case is the same.
        currency: input.currency ?? receivable.currency,
        date: fromIsoDate(input.date ?? todayIso()),
        accountId: input.accountId ?? null,
        note: input.note ?? null,
      },
    });
    await this.redis.invalidateUser(userId);
    const row = await this.prisma.receivable.findUniqueOrThrow({
      where: { id },
      include: INCLUDE,
    });
    return toDto(row as Row);
  }

  async removePayment(userId: string, id: string, paymentId: string): Promise<ReceivableDto> {
    await this.owned(userId, id);
    const { count } = await this.prisma.receivablePayment.deleteMany({
      where: { id: paymentId, receivableId: id, userId },
    });
    if (count === 0) throw new NotFoundException('Payment not found');
    await this.redis.invalidateUser(userId);
    const row = await this.prisma.receivable.findUniqueOrThrow({
      where: { id },
      include: INCLUDE,
    });
    return toDto(row as Row);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.owned(userId, id);
    await this.prisma.receivable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await this.redis.invalidateUser(userId);
  }

  private async owned(userId: string, id: string) {
    const row = await this.prisma.receivable.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true, currency: true },
    });
    if (!row) throw new NotFoundException('Loan not found');
    return row;
  }
}
