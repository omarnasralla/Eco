import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import webpush from 'web-push';
import { createHash } from 'node:crypto';
import type {
  NotificationDto,
  NotificationPreferences,
  NotificationType,
  Paginated,
} from '@eco/shared';
import { formatMoney } from '@eco/shared';
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
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  /** False when no VAPID keys are configured; pushes are then skipped quietly. */
  private pushReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const publicKey = this.config.get<string>('push.publicKey');
    const privateKey = this.config.get<string>('push.privateKey');
    if (!publicKey || !privateKey) {
      // Not an error. A machine with no keys configured simply does not push,
      // and everything else about a notification still works.
      this.logger.warn('No VAPID keys configured — push notifications are disabled');
      return;
    }
    webpush.setVapidDetails(
      this.config.getOrThrow<string>('push.subject'),
      publicKey,
      privateKey,
    );
    this.pushReady = true;
    this.logger.log('Web push configured');
  }

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
      await this.sendPush(userId, input.title, input.body, input.actionUrl);
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

  /** The VAPID public key, or null when push is not configured. */
  pushPublicKey(): string | null {
    return this.config.get<string>('push.publicKey') ?? null;
  }

  async registerPushToken(
    userId: string,
    input: {
      token: string;
      platform: 'IOS' | 'ANDROID' | 'WEB';
      deviceName?: string;
      p256dh?: string;
      auth?: string;
    },
  ): Promise<void> {
    await this.prisma.pushToken.upsert({
      where: { token: input.token },
      create: {
        userId,
        token: input.token,
        platform: input.platform,
        deviceName: input.deviceName ?? null,
        p256dh: input.p256dh ?? null,
        auth: input.auth ?? null,
      },
      // A device that changes hands should follow the new owner, not keep
      // pushing another person's balances to it.
      // The keys are refreshed too: a browser can re-subscribe to the same
      // endpoint with new ones, and stale keys fail encryption silently.
      update: {
        userId,
        lastUsedAt: new Date(),
        ...(input.p256dh ? { p256dh: input.p256dh } : {}),
        ...(input.auth ? { auth: input.auth } : {}),
      },
    });

    // Registering a device IS the request to be pushed to. Without this the
    // channel defaults to [IN_APP, EMAIL] and every push is skipped — a user
    // grants permission, sees a confirmation, and then never hears anything,
    // with nothing anywhere saying why.
    const preferences = await this.prisma.notificationPreference.findUnique({
      where: { userId },
      select: { channels: true },
    });
    if (!preferences) {
      await this.prisma.notificationPreference.create({
        data: { userId, channels: ['IN_APP', 'EMAIL', 'PUSH'] },
      });
    } else if (!preferences.channels.includes('PUSH')) {
      await this.prisma.notificationPreference.update({
        where: { userId },
        data: { channels: [...preferences.channels, 'PUSH'] },
      });
    }
    await this.redis.invalidateUser(userId);
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
   * Push delivery.
   *
   * Web Push is implemented; APNs and FCM are still ahead of us, and a token
   * for either is skipped rather than failing the send — one unsupported
   * device must not stop the others being notified.
   *
   * On iOS this reaches only a site added to the Home Screen: Apple does not
   * permit push from a Safari tab. Nothing here can change that, and it is
   * worth knowing when a user swears notifications are broken.
   */
  private async sendPush(userId: string, title: string, body: string, url?: string | null) {
    if (!this.pushReady) return;

    const tokens = await this.prisma.pushToken.findMany({ where: { userId } });
    if (tokens.length === 0) return;

    const payload = JSON.stringify({ title, body, url: url ?? '/eco/app' });

    await Promise.all(
      tokens.map(async (token) => {
        if (token.platform !== 'WEB' || !token.p256dh || !token.auth) return;
        try {
          await webpush.sendNotification(
            {
              endpoint: token.token,
              keys: { p256dh: token.p256dh, auth: token.auth },
            },
            payload,
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          // 404 and 410 are the push service saying this subscription is dead
          // — the app was deleted, or the browser dropped it. Keeping it means
          // failing on every future send forever, so it goes.
          if (status === 404 || status === 410) {
            await this.prisma.pushToken.delete({ where: { id: token.id } }).catch(() => undefined);
            this.logger.log(`Pruned expired push subscription for user ${userId}`);
            return;
          }
          this.logger.warn(`Push failed for user ${userId}: ${(error as Error).message}`);
        }
      }),
    );
  }

  /**
   * Alert that an automatic capture did not make it in.
   *
   * This exists because every failure of that kind was silent. A bank alert
   * that could not be parsed, a token that had been revoked, a reference
   * collision — all of them answered the phone and left no trace the user
   * would ever see, and a real purchase went missing for two days as a result.
   *
   * Deduped per day per reason: a shortcut misconfigured on Monday should say
   * so once, not once per purchase.
   */
  async captureFailed(userId: string, reason: string, detail?: string): Promise<void> {
    await this.create(userId, {
      type: 'CAPTURE_FAILED',
      title: 'An expense could not be recorded',
      body: detail
        ? `${reason}. ${detail}`
        : `${reason}. Tap to add it by hand, or check the shortcut on your phone.`,
      actionUrl: '/eco/app/expenses',
      dedupeKey: `capture-failed:${reason}:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  /**
   * Alert that a message arrived in a shape the parser has never seen.
   *
   * Distinct from a failure the user caused: this one means a bank changed its
   * wording and the parser needs a new pattern. The message itself is included
   * so it can be forwarded without hunting through a phone for it.
   */
  async captureUnknownFormat(userId: string, text: string): Promise<void> {
    await this.create(userId, {
      type: 'CAPTURE_UNKNOWN',
      title: 'A bank message was not recognised',
      body: `Nothing was recorded for: "${text.slice(0, 120)}"`,
      actionUrl: '/eco/app/expenses',
      // Keyed on the MESSAGE, not just the day. Keyed on the day alone, three
      // different unrecognised messages on one day left one notification and
      // threw the other two texts away — which is how a Contabo charge went
      // unrecorded for twelve days without anybody being able to see what the
      // message had said. The same message forwarded twice still collapses.
      dedupeKey: `capture-unknown:${createHash('sha256').update(text.trim()).digest('hex').slice(0, 32)}`,
    });
  }

  /**
   * A charge was cancelled because the bank reversed it.
   *
   * Worth saying out loud even though nothing needs doing: an expense
   * disappearing from the list on its own is alarming unless you are told why,
   * and this is the one capture that deletes rather than adds.
   */
  async expenseReversed(
    userId: string,
    merchant: string,
    amountMinor: number,
    currency: string,
  ): Promise<void> {
    await this.create(userId, {
      type: 'TRANSACTION_REVERSED',
      title: 'A charge was reversed',
      body: `${merchant} reversed ${formatMoney(amountMinor, currency)}. The expense has been removed.`,
      actionUrl: '/eco/app/expenses',
    });
  }

  /**
   * A reversal arrived with no charge to cancel.
   *
   * Not deduped by day: each unmatched reversal is a separate charge left
   * standing, and collapsing them would hide all but the first.
   */
  async reversalUnmatched(
    userId: string,
    merchant: string,
    amountMinor: number,
    currency: string,
  ): Promise<void> {
    await this.create(userId, {
      type: 'CAPTURE_FAILED',
      title: 'A reversal matched nothing',
      body:
        `The bank reversed ${formatMoney(amountMinor, currency)} at ${merchant}, ` +
        `but no recorded expense matched it. Nothing was changed.`,
      actionUrl: '/eco/app/expenses',
    });
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
  /**
   * One daily summary of captured expenses whose category was guessed.
   *
   * Batched on purpose. A push per purchase would arrive alongside the bank's
   * own SMS and say less than it does — two buzzes for one coffee is how a
   * person learns to swipe notifications away without reading them, which
   * costs the alerts that matter.
   *
   * Evening rather than morning: the point is to catch the day's spending once
   * it has happened, and quiet hours still apply on top.
   */
  @Cron(CronExpression.EVERY_DAY_AT_8PM)
  async remindUnreviewedCaptures(): Promise<void> {
    if (!(await this.redis.acquireLock('notification-review-digest', 600))) return;
    try {
      const pending = await this.prisma.expense.groupBy({
        by: ['userId'],
        where: { needsReview: true, deletedAt: null },
        _count: { _all: true },
      });

      for (const row of pending) {
        const count = row._count._all;
        await this.create(row.userId, {
          type: 'NEEDS_REVIEW',
          title: `${count} expense${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a category`,
          body:
            count === 1
              ? 'One captured expense was filed under a guess. Setting it teaches every future one.'
              : `${count} captured expenses were filed under a guess. Setting each one teaches every future purchase at that merchant.`,
          // Straight into the review list. Safari shows no action buttons on
          // a web push notification, so the destination is the only lever the
          // notification has — landing on the full list and asking the user to
          // find a filter would waste the tap.
          actionUrl: '/eco/app/expenses?review=1',
          // Once a day at most, however many times this runs.
          dedupeKey: `needs-review:${new Date().toISOString().slice(0, 10)}`,
        });
      }
    } finally {
      await this.redis.releaseLock('notification-review-digest');
    }
  }

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
