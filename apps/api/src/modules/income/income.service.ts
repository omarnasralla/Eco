import { Injectable, NotFoundException } from '@nestjs/common';
import { toMonthlyMinor } from '@eco/core';
import type { IncomeSourceDto, IncomeSourceInput } from '@eco/shared';
import type { IncomeSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { toNumber } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate, toIsoDate } from '../../common/utils/dates';

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
    input: { amountMinor: number; date: string; notes?: string | null },
    userCurrency: string,
  ) {
    const source = await this.prisma.incomeSource.findFirst({
      where: { id: incomeSourceId, userId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Income source not found');

    const receipt = await this.prisma.incomeReceipt.create({
      data: {
        userId,
        incomeSourceId,
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
    return {
      id: receipt.id,
      amountMinor: toNumber(receipt.amountMinor),
      date: requireIsoDate(receipt.date),
    };
  }

  /** Monthly run rate across every active stream, in the user's base currency. */
  async monthlyTotal(userId: string, userCurrency: string): Promise<number> {
    const sources = await this.prisma.incomeSource.findMany({
      where: { userId, deletedAt: null, isActive: true },
    });

    let total = 0;
    for (const source of sources) {
      const monthly = toMonthlyMinor(toNumber(source.amountMinor), source.frequency);
      total += await this.currency.convertForDisplay(monthly, source.currency, userCurrency);
    }
    return total;
  }
}
