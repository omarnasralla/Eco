import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { formatWorkTime, workHoursFor } from '@eco/core';
import {
  formatMoney,
  type UpdateWantInput,
  type WantDto,
  type WantInput,
  type WantsDto,
  type WantStatus,
} from '@eco/shared';
import type { Want } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CurrencyService } from '../currency/currency.service';
import { NotificationsService } from '../notifications/notifications.service';
import { toNumber } from '../../common/utils/money';
import { localClock } from '../../common/utils/dates';
import { WorkTimeService } from './work-time.service';

const HOUR_MS = 3_600_000;

/**
 * Local hours in which "your want is ready" may arrive. A cooling-off period
 * that ends at 03:00 waits until morning: the point is a considered decision,
 * and nobody makes one woken by a push.
 */
const READY_WINDOW = { from: 8 * 60, to: 21 * 60 };

/**
 * The cooling-off list.
 *
 * A want cannot be marked bought until its wait is over — that refusal is the
 * whole feature. Skipping is allowed at any time, since letting go early is
 * exactly the outcome the wait is for.
 */
@Injectable()
export class WantsService {
  private readonly logger = new Logger(WantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly currency: CurrencyService,
    private readonly notifications: NotificationsService,
    private readonly workTime: WorkTimeService,
  ) {}

  async list(userId: string, userCurrency: string): Promise<WantsDto> {
    const [rows, rate] = await Promise.all([
      this.prisma.want.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      this.workTime.rate(userId, userCurrency),
    ]);

    const items: WantDto[] = [];
    let skippedMinor = 0;
    for (const row of rows) {
      const dto = await this.toDto(row, userCurrency, rate.hourlyMinor);
      if (dto.status === 'SKIPPED') skippedMinor += dto.baseAmountMinor;
      items.push(dto);
    }

    return {
      items,
      rate,
      skippedMinor,
      skippedWorkHours: workHoursFor(skippedMinor, rate.hourlyMinor),
      currency: userCurrency,
    };
  }

  async create(userId: string, userCurrency: string, input: WantInput): Promise<WantDto> {
    const row = await this.prisma.want.create({
      data: {
        userId,
        name: input.name,
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency,
        url: input.url?.trim() || null,
        note: input.note?.trim() || null,
        coolOffHours: input.coolOffHours,
        readyAt: new Date(Date.now() + input.coolOffHours * HOUR_MS),
      },
    });
    return this.toDtoWithRate(row, userId, userCurrency);
  }

  async update(
    userId: string,
    id: string,
    userCurrency: string,
    input: UpdateWantInput,
  ): Promise<WantDto> {
    await this.require(userId, id);
    const row = await this.prisma.want.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.amountMinor !== undefined ? { amountMinor: BigInt(input.amountMinor) } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.url !== undefined ? { url: input.url?.trim() || null } : {}),
        ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      },
    });
    return this.toDtoWithRate(row, userId, userCurrency);
  }

  /** Refused while the wait is running; that refusal is the feature. */
  async buy(userId: string, id: string, userCurrency: string): Promise<WantDto> {
    const want = await this.require(userId, id);
    if (want.readyAt.getTime() > Date.now()) {
      const hoursLeft = Math.ceil((want.readyAt.getTime() - Date.now()) / HOUR_MS);
      throw new BadRequestException(
        `Still cooling off — ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} to go.`,
      );
    }
    const row = await this.prisma.want.update({
      where: { id },
      data: { boughtAt: new Date(), skippedAt: null },
    });
    return this.toDtoWithRate(row, userId, userCurrency);
  }

  async skip(userId: string, id: string, userCurrency: string): Promise<WantDto> {
    await this.require(userId, id);
    const row = await this.prisma.want.update({
      where: { id },
      data: { skippedAt: new Date(), boughtAt: null },
    });
    return this.toDtoWithRate(row, userId, userCurrency);
  }

  /** A mis-tap is undone back to where the wait left it, never to a fresh one. */
  async reopen(userId: string, id: string, userCurrency: string): Promise<WantDto> {
    await this.require(userId, id);
    const row = await this.prisma.want.update({
      where: { id },
      data: { boughtAt: null, skippedAt: null },
    });
    return this.toDtoWithRate(row, userId, userCurrency);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.require(userId, id);
    await this.prisma.want.delete({ where: { id } });
  }

  /** Names of wants whose wait is over and that are still undecided. */
  async readyNames(userId: string): Promise<string[]> {
    const rows = await this.prisma.want.findMany({
      where: { userId, readyAt: { lte: new Date() }, boughtAt: null, skippedAt: null },
      orderBy: { readyAt: 'asc' },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  /**
   * Tell the user once when a want's wait is over.
   *
   * Every minute, so the push lands on the deadline it was promised for; held
   * until the user's local morning when the deadline falls overnight.
   */
  @Cron('* * * * *')
  async announceReady(): Promise<void> {
    if (!(await this.redis.acquireLock('wants-ready', 600))) return;
    try {
      const due = await this.prisma.want.findMany({
        where: {
          readyAt: { lte: new Date() },
          readyNotifiedAt: null,
          boughtAt: null,
          skippedAt: null,
          user: { deletedAt: null },
        },
        include: { user: { select: { timezone: true, currency: true, locale: true } } },
        take: 200,
      });

      for (const want of due) {
        const { minutes } = localClock(want.user.timezone);
        if (minutes < READY_WINDOW.from || minutes >= READY_WINDOW.to) continue;

        const rate = await this.workTime.rate(want.userId, want.user.currency);
        const dto = await this.toDto(want, want.user.currency, rate.hourlyMinor);
        const price = formatMoney(dto.amountMinor, dto.currency, { locale: want.user.locale });
        const time =
          dto.workHours !== null && rate.workHoursPerWeek
            ? ` — ${formatWorkTime(dto.workHours, rate.workHoursPerWeek)} of work`
            : '';

        await this.notifications.create(want.userId, {
          type: 'WANT_READY',
          title: `${want.name} has cooled off`,
          body: `${waitLabel(want.coolOffHours)} are up. It costs ${price}${time}. Still want it?`,
          actionUrl: '/eco/app/wants',
          dedupeKey: `want-ready:${want.id}`,
        });
        await this.prisma.want.update({
          where: { id: want.id },
          data: { readyNotifiedAt: new Date() },
        });
      }
    } catch (error) {
      this.logger.error(`Ready sweep failed: ${(error as Error).message}`);
    } finally {
      await this.redis.releaseLock('wants-ready');
    }
  }

  private async require(userId: string, id: string): Promise<Want> {
    const row = await this.prisma.want.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Want not found');
    return row;
  }

  private async toDtoWithRate(row: Want, userId: string, userCurrency: string) {
    const rate = await this.workTime.rate(userId, userCurrency);
    return this.toDto(row, userCurrency, rate.hourlyMinor);
  }

  private async toDto(row: Want, userCurrency: string, hourlyMinor: number | null): Promise<WantDto> {
    const amount = toNumber(row.amountMinor);
    // Today's rate, not the rate on the day it was added: the question is what
    // it costs to buy now.
    const base = await this.currency.convertForDisplay(amount, row.currency, userCurrency);
    return {
      id: row.id,
      name: row.name,
      amountMinor: amount,
      currency: row.currency,
      baseAmountMinor: base,
      workHours: workHoursFor(base, hourlyMinor),
      url: row.url,
      note: row.note,
      coolOffHours: row.coolOffHours,
      readyAt: row.readyAt.toISOString(),
      status: statusOf(row),
      decidedAt: (row.boughtAt ?? row.skippedAt)?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function statusOf(row: Pick<Want, 'boughtAt' | 'skippedAt' | 'readyAt'>): WantStatus {
  if (row.boughtAt) return 'BOUGHT';
  if (row.skippedAt) return 'SKIPPED';
  return row.readyAt.getTime() <= Date.now() ? 'READY' : 'COOLING';
}

/** "48 hours", "3 days", "1 week". */
function waitLabel(hours: number): string {
  if (hours % 168 === 0) return `${hours / 168} week${hours === 168 ? '' : 's'}`;
  if (hours % 24 === 0 && hours > 48) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
