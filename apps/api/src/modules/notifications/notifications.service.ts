import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type {
  NotificationDto,
  NotificationPreferences,
  NotificationType,
  Paginated,
} from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { MailService } from '../mail/mail.service';

export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  actionUrl?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Idempotency key. A nightly job that re-detects the same condition writes
   * the same key, so the user is told once rather than every night until they
   * act on it.
   */
  dedupeKey?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
  ) {}

  async create(userId: string, input: CreateNotificationInput): Promise<NotificationDto | null> {
    const preferences = await this.getPreferences(userId);
    if (!this.isTypeEnabled(input.type, preferences)) return null;

    // Upsert on the dedupe key so a repeated finding refreshes in place.
    const existing = input.dedupeKey
      ? await this.prisma.notification.findUnique({
          where: { userId_dedupeKey: { userId, dedupeKey: input.dedupeKey } },
        })
      : null;

    if (existing) return this.toDto(existing);

    const notification = await this.prisma.notification.create({
      data: {
        userId,
        type: input.type,
        channel: 'IN_APP',
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl ?? null,
        metadata: (input.metadata ?? null) as never,
        dedupeKey: input.dedupeKey ?? null,
      },
    });

    if (preferences.channels.includes('EMAIL') && !this.isQuietHours(preferences)) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });
      if (user) {
        await this.mail.sendNotification(
          user.email,
          input.title,
          input.title,
          input.body,
          input.actionUrl ?? undefined,
        );
      }
    }

    if (preferences.channels.includes('PUSH') && !this.isQuietHours(preferences)) {
      await this.sendPush(userId, input.title, input.body);
    }

    return this.toDto(notification);
  }

  async findAll(
    userId: string,
    options: { unreadOnly?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<Paginated<NotificationDto>> {
    const limit = options.limit ?? 30;
    const rows = await this.prisma.notification.findMany({
      where: { userId, ...(options.unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: items.map((n) => this.toDto(n)),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return { updated: count };
  }

  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const stored = await this.prisma.notificationPreference.findUnique({ where: { userId } });
    if (!stored) {
      // A user created before this table existed still gets sane defaults
      // rather than a crash on their first notification.
      return {
        channels: ['IN_APP', 'EMAIL'],
        billDueLeadDays: 3,
        budgetWarnings: true,
        debtReminders: true,
        savingsMilestones: true,
        aiInsights: true,
        quietHoursStart: null,
        quietHoursEnd: null,
      };
    }

    return {
      channels: stored.channels,
      billDueLeadDays: stored.billDueLeadDays,
      budgetWarnings: stored.budgetWarnings,
      debtReminders: stored.debtReminders,
      savingsMilestones: stored.savingsMilestones,
      aiInsights: stored.aiInsights,
      quietHoursStart: stored.quietHoursStart,
      quietHoursEnd: stored.quietHoursEnd,
    };
  }

  async updatePreferences(
    userId: string,
    input: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    // Written out field by field rather than spreading the DTO: it keeps
    // unknown keys out of the update and makes a renamed preference a compile
    // error instead of a silently ignored write.
    const data = {
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.billDueLeadDays !== undefined
        ? { billDueLeadDays: input.billDueLeadDays }
        : {}),
      ...(input.budgetWarnings !== undefined ? { budgetWarnings: input.budgetWarnings } : {}),
      ...(input.debtReminders !== undefined ? { debtReminders: input.debtReminders } : {}),
      ...(input.savingsMilestones !== undefined
        ? { savingsMilestones: input.savingsMilestones }
        : {}),
      ...(input.aiInsights !== undefined ? { aiInsights: input.aiInsights } : {}),
      ...(input.quietHoursStart !== undefined
        ? { quietHoursStart: input.quietHoursStart }
        : {}),
      ...(input.quietHoursEnd !== undefined ? { quietHoursEnd: input.quietHoursEnd } : {}),
    };

    const updated = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    return {
      channels: updated.channels,
      billDueLeadDays: updated.billDueLeadDays,
      budgetWarnings: updated.budgetWarnings,
      debtReminders: updated.debtReminders,
      savingsMilestones: updated.savingsMilestones,
      aiInsights: updated.aiInsights,
      quietHoursStart: updated.quietHoursStart,
      quietHoursEnd: updated.quietHoursEnd,
    };
  }

  async registerPushToken(
    userId: string,
    input: { token: string; platform: 'IOS' | 'ANDROID' | 'WEB'; deviceName?: string },
  ): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token: input.token },
      create: {
        userId,
        token: input.token,
        platform: input.platform,
        deviceName: input.deviceName ?? null,
      },
      // A device that changes hands should follow the new owner, not keep
      // pushing another person's balances to it.
      update: { userId, lastUsedAt: new Date() },
    });
  }

  private isTypeEnabled(type: NotificationType, prefs: NotificationPreferences): boolean {
    switch (type) {
      case 'BUDGET_EXCEEDED':
      case 'BUDGET_WARNING':
        return prefs.budgetWarnings;
      case 'DEBT_DUE':
      case 'BILL_DUE':
        return prefs.debtReminders;
      case 'SAVINGS_MILESTONE':
      case 'GOAL_ACHIEVED':
        return prefs.savingsMilestones;
      case 'AI_INSIGHT':
        return prefs.aiInsights;
      // Security alerts are never opt-out. A user who has turned off
      // notifications still needs to know their password was changed.
      case 'SECURITY_ALERT':
      case 'SYSTEM':
        return true;
      default:
        return true;
    }
  }

  /** Handles windows that wrap past midnight (22:00 → 08:00). */
  private isQuietHours(prefs: NotificationPreferences): boolean {
    if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;

    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };

    const start = toMinutes(prefs.quietHoursStart);
    const end = toMinutes(prefs.quietHoursEnd);

    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  }

  /**
   * Push delivery. The transport (APNs / FCM / Web Push) is deliberately behind
   * this one method: when the React Native app ships, only this body changes.
   */
  private async sendPush(userId: string, title: string, body: string): Promise<void> {
    const tokens = await this.prisma.pushToken.findMany({ where: { userId } });
    if (tokens.length === 0) return;

    this.logger.debug(`Would push "${title}" to ${tokens.length} device(s) for user ${userId}`);
    // TODO(phase-3): dispatch through FCM/APNs and prune tokens the provider
    // reports as unregistered.
  }

  private toDto(notification: {
    id: string;
    type: string;
    title: string;
    body: string;
    channel: string;
    isRead: boolean;
    actionUrl: string | null;
    metadata: unknown;
    createdAt: Date;
  }): NotificationDto {
    return {
      id: notification.id,
      type: notification.type as NotificationType,
      title: notification.title,
      body: notification.body,
      channel: notification.channel as NotificationDto['channel'],
      isRead: notification.isRead,
      actionUrl: notification.actionUrl,
      metadata: (notification.metadata as Record<string, unknown> | null) ?? null,
      createdAt: notification.createdAt.toISOString(),
    };
  }

  /**
   * Nightly sweep for upcoming debt payments. Runs on every replica, so a
   * distributed lock keeps exactly one of them doing the work.
   */
  @Cron(CronExpression.EVERY_DAY_AT_8AM)
  async sendBillReminders(): Promise<void> {
    if (!(await this.redis.acquireLock('bill-reminders', 600))) return;

    try {
      const debts = await this.prisma.debt.findMany({
        where: { deletedAt: null, isClosed: false },
        include: { user: { select: { id: true, deletedAt: true } } },
      });

      const today = new Date();
      const todayDay = today.getUTCDate();
      let sent = 0;

      for (const debt of debts) {
        if (debt.user.deletedAt) continue;

        const prefs = await this.getPreferences(debt.userId);
        const leadDays = prefs.billDueLeadDays;

        // Compare against the due day rather than constructing dates, so a
        // 31st due day in a 30-day month still fires on the last day.
        const daysInMonth = new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
        ).getUTCDate();
        const effectiveDueDay = Math.min(debt.dueDayOfMonth, daysInMonth);
        const daysUntil = effectiveDueDay - todayDay;

        if (daysUntil < 0 || daysUntil > leadDays) continue;

        const monthKey = today.toISOString().slice(0, 7);
        const created = await this.create(debt.userId, {
          type: 'DEBT_DUE',
          title: `${debt.name} payment due ${daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`}`,
          body: `Your minimum payment for ${debt.name} is due on the ${effectiveDueDay}${daysUntil === 0 ? ' — today' : ''}.`,
          actionUrl: `/debts/${debt.id}`,
          dedupeKey: `debt:${debt.id}:due:${monthKey}`,
        });
        if (created) sent += 1;
      }

      if (sent > 0) this.logger.log(`Sent ${sent} bill reminders`);
    } finally {
      await this.redis.releaseLock('bill-reminders');
    }
  }

  /** Drops read notifications older than 90 days. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneOld(): Promise<void> {
    if (!(await this.redis.acquireLock('notification-prune', 600))) return;
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 3_600 * 1000);
      const { count } = await this.prisma.notification.deleteMany({
        where: { isRead: true, createdAt: { lt: cutoff } },
      });
      if (count > 0) this.logger.log(`Pruned ${count} old notifications`);
    } finally {
      await this.redis.releaseLock('notification-prune');
    }
  }
}
