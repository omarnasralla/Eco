import { Injectable, NotFoundException } from '@nestjs/common';
import { orderTasks, taskState, type IsoDate } from '@eco/core';
import type { TaskDto, TaskInput, UpdateTaskInput } from '@eco/shared';
import type { Task } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { fromIsoDate, localClock, toIsoDate } from '../../common/utils/dates';

/** How long a finished task stays on the list, so today's wins are visible. */
const DONE_VISIBLE_DAYS = 7;

/**
 * Things to do. Deliberately plain — a title and an optional date — because a
 * list that asks for priority, project and tags at entry is a list nobody
 * keeps. The order does the prioritising: overdue first, then by date.
 *
 * "Today" and "overdue" are judged on the user's own calendar, not UTC: in
 * Riyadh a task due today becomes overdue at local midnight, three hours
 * before the server would say so.
 */
@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, timezone: string): Promise<TaskDto[]> {
    const since = new Date(Date.now() - DONE_VISIBLE_DAYS * 86_400_000);
    const rows = await this.prisma.task.findMany({
      where: { userId, OR: [{ doneAt: null }, { doneAt: { gte: since } }] },
    });
    return this.ordered(rows, timezone);
  }

  /** Open tasks only, in order of attention — what the briefing names. */
  async open(userId: string, timezone: string): Promise<TaskDto[]> {
    const rows = await this.prisma.task.findMany({ where: { userId, doneAt: null } });
    return this.ordered(rows, timezone);
  }

  async create(userId: string, timezone: string, input: TaskInput): Promise<TaskDto> {
    const row = await this.prisma.task.create({
      data: {
        userId,
        title: input.title,
        dueOn: input.dueOn ? fromIsoDate(input.dueOn) : null,
      },
    });
    return toDto(row, today(timezone));
  }

  async update(
    userId: string,
    id: string,
    timezone: string,
    input: UpdateTaskInput,
  ): Promise<TaskDto> {
    await this.require(userId, id);
    const row = await this.prisma.task.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.dueOn !== undefined
          ? { dueOn: input.dueOn ? fromIsoDate(input.dueOn) : null }
          : {}),
      },
    });
    return toDto(row, today(timezone));
  }

  async setDone(userId: string, id: string, timezone: string, done: boolean): Promise<TaskDto> {
    await this.require(userId, id);
    const row = await this.prisma.task.update({
      where: { id },
      data: { doneAt: done ? new Date() : null },
    });
    return toDto(row, today(timezone));
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.require(userId, id);
    await this.prisma.task.delete({ where: { id } });
  }

  private ordered(rows: Task[], timezone: string): TaskDto[] {
    const date = today(timezone);
    return orderTasks(rows.map((r) => toDto(r, date)), date);
  }

  private async require(userId: string, id: string): Promise<Task> {
    const row = await this.prisma.task.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('Task not found');
    return row;
  }
}

function today(timezone: string): IsoDate {
  return localClock(timezone).date as IsoDate;
}

function toDto(row: Task, date: IsoDate): TaskDto {
  const base = {
    dueOn: toIsoDate(row.dueOn) as IsoDate | null,
    doneAt: row.doneAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
  return {
    id: row.id,
    title: row.title,
    ...base,
    status: taskState(base, date),
  };
}
