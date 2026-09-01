import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  completeMonthsOnly,
  forecastCashFlow,
  monthlyTotals,
  seasonalityIndex,
} from '@eco/core';
import {
  CACHE_TTL_SECONDS,
  formatMoney,
  type AiChatResponseDto,
  type ForecastDto,
  type RecommendationDto,
} from '@eco/shared';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IncomeService } from '../income/income.service';
import { GoalsService } from '../goals/goals.service';
import { AiContextService } from './ai-context.service';
import { toNumber, toNumberOrNull } from '../../common/utils/money';
import { todayIso } from '../../common/utils/dates';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly serviceUrl: string;
  private readonly serviceToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly context: AiContextService,
    private readonly notifications: NotificationsService,
    private readonly income: IncomeService,
    private readonly goals: GoalsService,
  ) {
    this.serviceUrl = config.getOrThrow<string>('ai.serviceUrl');
    this.serviceToken = config.getOrThrow<string>('ai.serviceToken');
  }

  /**
   * Forecast, delegated to the Python service.
   *
   * That service runs Holt-Winters and gradient-boosted models over the full
   * history. When it is unreachable we fall back to the in-process forecaster
   * in @eco/core: a slightly cruder number now beats an error page, and the
   * response says which model produced it so nothing is misrepresented.
   */
  async forecast(
    userId: string,
    userCurrency: string,
    horizonMonths = 6,
  ): Promise<ForecastDto> {
    const cacheKey = this.redis.key(userId, 'forecast', horizonMonths);

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS.forecast, async () => {
      const transactions = await this.context.transactions(userId, 24);
      const monthlyIncomeMinor = await this.income.monthlyTotal(userId, userCurrency);
      const openingBalanceMinor = await this.goals.totalSaved(userId);
      // Complete months only: the month in progress is partial, and feeding it
      // in as though it were finished reads as a collapse in spending.
      const expenseHistory = completeMonthsOnly(
        monthlyTotals(transactions).map((t) => ({
          month: t.month,
          valueMinor: t.amountMinor,
        })),
        todayIso(),
      );

      try {
        const remote = await this.callAiService<ForecastDto>('/forecast', {
          user_id: userId,
          currency: userCurrency,
          horizon_months: horizonMonths,
          opening_balance_minor: openingBalanceMinor,
          monthly_income_minor: monthlyIncomeMinor,
          expense_history: expenseHistory.map((p) => ({
            month: p.month,
            value_minor: p.valueMinor,
          })),
        });

        await this.prisma.forecastSnapshot.create({
          data: {
            userId,
            horizonMonths,
            model: remote.model,
            confidence: remote.confidence,
            payload: remote as never,
            expiresAt: new Date(Date.now() + 30 * 24 * 3_600 * 1000),
          },
        });

        return remote;
      } catch (error) {
        this.logger.warn(
          `AI service forecast failed (${(error as Error).message}); using the local model`,
        );

        const seasonal = seasonalityIndex(monthlyTotals(transactions)).map((s) => s.indexVsAverage);
        const local = forecastCashFlow({
          incomeHistory: expenseHistory.map((p) => ({
            month: p.month,
            valueMinor: monthlyIncomeMinor,
          })),
          expenseHistory,
          openingBalanceMinor,
          horizon: horizonMonths,
          seasonalIndices: seasonal,
        });

        return {
          generatedAt: new Date().toISOString(),
          model: 'holt-damped-local',
          currency: userCurrency,
          horizonMonths,
          confidence: local.confidence,
          points: local.points,
          warnings: [
            ...local.warnings,
            'Generated locally because the forecasting service was unavailable; accuracy may be lower than usual.',
          ],
        } satisfies ForecastDto;
      }
    });
  }

  /** Learned spending patterns, cached because the analysis is not cheap. */
  async patterns(userId: string, userCurrency: string) {
    return this.redis.remember(
      this.redis.key(userId, 'patterns'),
      CACHE_TTL_SECONDS.patterns,
      () => this.context.patterns(userId, userCurrency),
    );
  }

  /**
   * Recommendations, computed deterministically and persisted.
   *
   * Every figure comes from @eco/core running over the user's own ledger. The
   * LLM never invents an amount — it only rewrites these findings when the user
   * asks about them in chat. That separation is what makes the advice
   * reproducible and auditable, which matters when someone acts on it.
   */
  async recommendations(userId: string, userCurrency: string): Promise<RecommendationDto[]> {
    const { recommendations } = await this.context.insights(userId, userCurrency);

    const stored = await Promise.all(
      recommendations.map(async (rec) => {
        // Fingerprint on kind + title so a nightly regeneration of the same
        // finding updates in place instead of stacking duplicates.
        const fingerprint = createHash('sha256')
          .update(`${rec.kind}:${rec.title}`)
          .digest('hex')
          .slice(0, 40);

        return this.prisma.recommendation.upsert({
          where: { userId_fingerprint: { userId, fingerprint } },
          create: {
            userId,
            kind: rec.kind,
            title: rec.title,
            body: rec.body,
            estimatedImpactMinor:
              rec.estimatedImpactMinor != null ? BigInt(rec.estimatedImpactMinor) : null,
            currency: userCurrency,
            priority: rec.priority,
            evidence: rec.evidence as never,
            actionUrl: rec.actionUrl,
            fingerprint,
            expiresAt: new Date(Date.now() + 14 * 24 * 3_600 * 1000),
          },
          update: {
            title: rec.title,
            body: rec.body,
            estimatedImpactMinor:
              rec.estimatedImpactMinor != null ? BigInt(rec.estimatedImpactMinor) : null,
            priority: rec.priority,
            evidence: rec.evidence as never,
            expiresAt: new Date(Date.now() + 14 * 24 * 3_600 * 1000),
          },
        });
      }),
    );

    return stored
      .filter((r) => r.status !== 'DISMISSED')
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        title: r.title,
        body: r.body,
        estimatedImpactMinor: toNumberOrNull(r.estimatedImpactMinor),
        currency: r.currency,
        priority: r.priority as RecommendationDto['priority'],
        evidence: r.evidence as RecommendationDto['evidence'],
        actionUrl: r.actionUrl,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  async dismissRecommendation(userId: string, id: string): Promise<void> {
    await this.prisma.recommendation.updateMany({
      where: { id, userId },
      data: { status: 'DISMISSED', dismissedAt: new Date() },
    });
  }

  async healthScore(userId: string, userCurrency: string) {
    const { health } = await this.context.insights(userId, userCurrency);
    return health;
  }

  /**
   * Chat.
   *
   * The API assembles a compact, aggregated context and hands it to the Python
   * service alongside the question. The model sees pre-computed figures, not
   * database access and not a raw transaction dump — so it cannot query outside
   * this user's data, and a prompt injection in a merchant name has nothing to
   * escalate to.
   */
  async chat(
    userId: string,
    userCurrency: string,
    message: string,
    conversationId?: string,
  ): Promise<AiChatResponseDto> {
    const conversation = conversationId
      ? await this.prisma.aiConversation.findFirst({ where: { id: conversationId, userId } })
      : null;

    const activeConversation =
      conversation ??
      (await this.prisma.aiConversation.create({
        data: { userId, title: message.slice(0, 80) },
      }));

    await this.prisma.aiMessage.create({
      data: { conversationId: activeConversation.id, role: 'user', content: message },
    });

    const history = await this.prisma.aiMessage.findMany({
      where: { conversationId: activeConversation.id },
      orderBy: { createdAt: 'asc' },
      // Only the recent turns: a long history costs tokens and latency without
      // improving answers about this month's spending.
      take: 12,
      select: { role: true, content: true },
    });

    const [snapshot, patterns, forecast] = await Promise.all([
      this.context.buildSnapshot(userId, userCurrency),
      this.patterns(userId, userCurrency),
      this.forecast(userId, userCurrency, 6),
    ]);

    const started = Date.now();
    let content: string;
    let model = 'unavailable';
    let tokensUsed: number | undefined;

    try {
      const response = await this.callAiService<{
        content: string;
        model: string;
        tokens_used?: number;
        suggestions?: string[];
      }>('/chat', {
        user_id: userId,
        message,
        history: history.map((h) => ({ role: h.role, content: h.content })),
        context: {
          currency: userCurrency,
          monthly_income_minor: snapshot.monthlyIncomeMinor,
          monthly_expenses_minor: snapshot.monthlyExpensesMinor,
          liquid_savings_minor: snapshot.liquidSavingsMinor,
          emergency_fund_target_minor: snapshot.emergencyFundTargetMinor,
          spend_by_category: snapshot.spendByCategory,
          debts: snapshot.debts,
          recurring: patterns.recurringExpenses.slice(0, 15),
          forecast: forecast.points,
        },
      });

      content = response.content;
      model = response.model;
      tokensUsed = response.tokens_used;

      await this.prisma.aiMessage.create({
        data: {
          conversationId: activeConversation.id,
          role: 'assistant',
          content,
          model,
          tokensUsed: tokensUsed ?? null,
          latencyMs: Date.now() - started,
        },
      });

      return {
        conversationId: activeConversation.id,
        message: {
          id: activeConversation.id,
          role: 'assistant',
          content,
          createdAt: new Date().toISOString(),
          ...(tokensUsed !== undefined ? { tokensUsed } : {}),
        },
        suggestions: response.suggestions ?? this.defaultSuggestions(),
      };
    } catch (error) {
      this.logger.error(`AI chat failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException(
        'Eco AI is temporarily unavailable. Your financial data is unaffected — please try again shortly.',
      );
    }
  }

  async listConversations(userId: string) {
    const conversations = await this.prisma.aiConversation.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    return conversations.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    }));
  }

  async getConversation(userId: string, conversationId: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) return null;

    return {
      id: conversation.id,
      title: conversation.title,
      messages: conversation.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
        ...(m.tokensUsed !== null ? { tokensUsed: m.tokensUsed } : {}),
      })),
    };
  }

  async deleteConversation(userId: string, conversationId: string): Promise<void> {
    await this.prisma.aiConversation.deleteMany({ where: { id: conversationId, userId } });
  }

  private defaultSuggestions(): string[] {
    return [
      'How much did I spend on food last month?',
      'What category wastes most of my money?',
      'Can I afford a vacation next summer?',
      'Predict my finances for the next 6 months.',
    ];
  }

  private async callAiService<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.serviceUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.serviceToken}`,
      },
      body: JSON.stringify(body),
      // A local 3B model on CPU can take 30 seconds; beyond 60 the user has
      // long since given up, so fail and surface the fallback.
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`AI service returned ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Nightly: recompute insights for active users and notify on high-priority
   * findings. Bounded to users who have been active recently — recomputing
   * for a dormant account is pure cost.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async generateNightlyInsights(): Promise<void> {
    if (!(await this.redis.acquireLock('nightly-insights', 3_600))) return;

    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 3_600 * 1000);
      const users = await this.prisma.user.findMany({
        where: { deletedAt: null, lastLoginAt: { gte: cutoff } },
        select: { id: true, currency: true },
        take: 5_000,
      });

      let notified = 0;

      for (const user of users) {
        try {
          const recommendations = await this.recommendations(user.id, user.currency);
          const urgent = recommendations.filter((r) => r.priority === 'HIGH' && r.status === 'NEW');

          for (const rec of urgent.slice(0, 2)) {
            const created = await this.notifications.create(user.id, {
              type: 'AI_INSIGHT',
              title: rec.title,
              body: rec.body,
              actionUrl: rec.actionUrl,
              dedupeKey: `insight:${rec.id}`,
            });
            if (created) notified += 1;
          }
        } catch (error) {
          // One user's bad data must not stop the batch.
          this.logger.warn(`Insight generation failed for ${user.id}: ${(error as Error).message}`);
        }
      }

      this.logger.log(`Nightly insights: ${users.length} users, ${notified} notifications`);
    } finally {
      await this.redis.releaseLock('nightly-insights');
    }
  }
}
