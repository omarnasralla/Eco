import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { composeBriefing, type BriefingInput } from '@eco/core';
import type { BriefingDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { BudgetsService } from '../budgets/budgets.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WantsService } from '../wants/wants.service';
import { TasksService } from '../tasks/tasks.service';
import { BirthdaysService } from '../birthdays/birthdays.service';
import { WeatherService } from '../weather/weather.service';
import { hhmmToMinutes, localClock } from '../../common/utils/dates';

/**
 * How late a briefing may still go out. An API restarted at 09:00 should still
 * send a 07:30 briefing; one restarted at 14:00 should not send a "morning"
 * message in the afternoon.
 */
const LATE_GRACE_MINUTES = 180;

/** Birthdays mentioned this many days ahead — enough to buy a present. */
const BIRTHDAY_LEAD_DAYS = 7;

/**
 * One push each morning: what can be spent today, and what is due or waiting.
 *
 * Assembled from figures other modules already compute — the budget's own
 * today allowance, the dashboard's upcoming bills — so the briefing can never
 * disagree with the screen it links to.
 */
@Injectable()
export class BriefingService {
  private readonly logger = new Logger(BriefingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly budgets: BudgetsService,
    private readonly dashboard: DashboardService,
    private readonly notifications: NotificationsService,
    private readonly wants: WantsService,
    private readonly tasks: TasksService,
    private readonly birthdays: BirthdaysService,
    private readonly weather: WeatherService,
  ) {}

  async build(userId: string): Promise<BriefingDto> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { currency: true, timezone: true, locale: true },
    });
    const { date } = localClock(user.timezone);
    const preferences = await this.notifications.getPreferences(userId);

    const [budget, bills, wantsReady, needsReview, tasks, birthdays, weather] = await Promise.all([
      this.budgets.findByMonth(userId, date.slice(0, 7), user.currency),
      // The same lead time as the bill reminders, so the two never disagree
      // about what counts as "due soon".
      this.dashboard.upcomingBills(userId, preferences.billDueLeadDays),
      this.wants.readyNames(userId),
      this.prisma.expense.count({ where: { userId, needsReview: true, deletedAt: null } }),
      this.tasks.open(userId, user.timezone),
      this.birthdays.within(userId, user.timezone, BIRTHDAY_LEAD_DAYS),
      this.weather.today(userId),
    ]);

    const today = budget?.todayAllowance;
    const pace = budget?.dailyAllowance;
    const input: BriefingInput = {
      date,
      locale: user.locale,
      today: today ? { remainingMinor: today.totalRemainingTodayMinor, currency: today.currency } : null,
      month: pace
        ? {
            remainingMinor: pace.totalRemainingMinor,
            daysRemaining: pace.daysRemainingInclusive,
            currency: pace.currency,
          }
        : null,
      bills: bills.map((b) => ({
        name: b.name,
        amountMinor: b.amountMinor,
        currency: b.currency,
        daysUntilDue: b.daysUntilDue,
      })),
      wantsReady,
      needsReview,
      weather,
      // Due tasks only, plus undated ones: a task due next month is not this
      // morning's business, and naming it would push today's off the screen.
      tasks: tasks
        .filter((t) => t.status !== 'UPCOMING')
        .map((t) => ({ title: t.title, overdue: t.status === 'OVERDUE' })),
      birthdays: birthdays.map((b) => ({
        name: b.name,
        daysUntil: b.daysUntil,
        turning: b.turning,
      })),
    };

    return { date, ...composeBriefing(input) };
  }

  /**
   * Send one now, outside the schedule — the "show me what it looks like"
   * button. Not deduplicated, and it does not count as the day's briefing.
   */
  async sendNow(userId: string): Promise<BriefingDto & { pushDevices: number; pushOn: boolean }> {
    const briefing = await this.build(userId);
    await this.deliver(userId, briefing, undefined);
    const [pushDevices, preferences] = await Promise.all([
      this.prisma.pushToken.count({ where: { userId, platform: 'WEB' } }),
      this.notifications.getPreferences(userId),
    ]);
    return { ...briefing, pushDevices, pushOn: preferences.channels.includes('PUSH') };
  }

  /**
   * Every minute, find the users whose briefing time has arrived on their own
   * clock and who have not had today's. Every minute so 07:40 means 07:40; a
   * tick is one query plus a lookup per user whose window is open.
   */
  @Cron('* * * * *')
  async sendDue(): Promise<void> {
    if (!(await this.redis.acquireLock('daily-briefing', 600))) return;
    let sent = 0;
    try {
      const subscribers = await this.prisma.notificationPreference.findMany({
        where: { dailyBriefing: true, user: { deletedAt: null } },
        select: { userId: true, briefingTime: true, user: { select: { timezone: true } } },
      });

      for (const sub of subscribers) {
        const clock = localClock(sub.user.timezone);
        const target = hhmmToMinutes(sub.briefingTime);
        if (clock.minutes < target || clock.minutes >= target + LATE_GRACE_MINUTES) continue;

        const dedupeKey = `briefing:${clock.date}`;
        const already = await this.prisma.notification.findUnique({
          where: { userId_dedupeKey: { userId: sub.userId, dedupeKey } },
          select: { id: true },
        });
        if (already) continue;

        try {
          await this.deliver(sub.userId, await this.build(sub.userId), dedupeKey);
          sent += 1;
        } catch (error) {
          // One user's broken data must not cost everyone else their morning.
          this.logger.warn(`Briefing failed for user ${sub.userId}: ${(error as Error).message}`);
        }
      }
    } finally {
      await this.redis.releaseLock('daily-briefing');
    }
    if (sent > 0) this.logger.log(`Sent ${sent} daily briefing${sent === 1 ? '' : 's'}`);
  }

  private async deliver(userId: string, briefing: BriefingDto, dedupeKey: string | undefined) {
    await this.notifications.create(userId, {
      type: 'DAILY_BRIEFING',
      title: briefing.title,
      body: briefing.lines.join('\n'),
      // The Today page holds every part of the briefing; the dashboard only
      // the money.
      actionUrl: '/eco/app/today',
      ...(dedupeKey ? { dedupeKey } : {}),
      scheduled: true,
    });
  }
}
