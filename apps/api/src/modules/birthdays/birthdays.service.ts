import { Injectable, NotFoundException } from '@nestjs/common';
import { nextBirthday, type IsoDate } from '@eco/core';
import type { BirthdayDto, BirthdayInput, UpdateBirthdayInput } from '@eco/shared';
import type { Birthday } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { localClock } from '../../common/utils/dates';

/**
 * Birthdays, ordered by when they next fall rather than by month — the
 * question is always "whose is coming up", never "who was born in March".
 */
@Injectable()
export class BirthdaysService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, timezone: string): Promise<BirthdayDto[]> {
    const rows = await this.prisma.birthday.findMany({ where: { userId } });
    const today = localClock(timezone).date as IsoDate;
    return rows.map((r) => toDto(r, today)).sort((a, b) => a.daysUntil - b.daysUntil);
  }

  /** Falling within `days` from today, today included. */
  async within(userId: string, timezone: string, days: number): Promise<BirthdayDto[]> {
    return (await this.list(userId, timezone)).filter((b) => b.daysUntil <= days);
  }

  async create(userId: string, timezone: string, input: BirthdayInput): Promise<BirthdayDto> {
    const row = await this.prisma.birthday.create({
      data: {
        userId,
        name: input.name,
        month: input.month,
        day: input.day,
        year: input.year ?? null,
        note: input.note?.trim() || null,
      },
    });
    return toDto(row, localClock(timezone).date as IsoDate);
  }

  async update(
    userId: string,
    id: string,
    timezone: string,
    input: UpdateBirthdayInput,
  ): Promise<BirthdayDto> {
    await this.require(userId, id);
    const row = await this.prisma.birthday.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.month !== undefined ? { month: input.month } : {}),
        ...(input.day !== undefined ? { day: input.day } : {}),
        ...(input.year !== undefined ? { year: input.year ?? null } : {}),
        ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
      },
    });
    return toDto(row, localClock(timezone).date as IsoDate);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.require(userId, id);
    await this.prisma.birthday.delete({ where: { id } });
  }

  private async require(userId: string, id: string): Promise<Birthday> {
    const row = await this.prisma.birthday.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Birthday not found');
    return row;
  }
}

function toDto(row: Birthday, today: IsoDate): BirthdayDto {
  const next = nextBirthday(row, today);
  return {
    id: row.id,
    name: row.name,
    month: row.month,
    day: row.day,
    year: row.year,
    note: row.note,
    nextDate: next.date,
    daysUntil: next.daysUntil,
    turning: next.turning,
  };
}
