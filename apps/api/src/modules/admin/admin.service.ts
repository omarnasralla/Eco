import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AdminStats, AdminUpdateUserInput, AdminUserDetail, AdminUserRow, AdminUserQuery, Paginated } from '@eco/shared';
import type { Prisma, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';

/** Everything the console needs about an account, and nothing it must never see. */
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  currency: true,
  country: true,
  emailVerified: true,
  twoFactorEnabled: true,
  deletedAt: true,
  lockedUntil: true,
  failedLoginAttempts: true,
  lastLoginAt: true,
  createdAt: true,
  _count: {
    select: { expenses: true, incomeSources: true, debts: true, savingsGoals: true, budgets: true },
  },
} satisfies Prisma.UserSelect;

type UserWithCounts = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function toRow(user: UserWithCounts): AdminUserRow {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    currency: user.currency,
    country: user.country,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    lockedUntil: user.lockedUntil?.toISOString() ?? null,
    failedLoginAttempts: user.failedLoginAttempts,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    counts: {
      expenses: user._count.expenses,
      incomeSources: user._count.incomeSources,
      debts: user._count.debts,
      goals: user._count.savingsGoals,
      budgets: user._count.budgets,
    },
  };
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  async stats(): Promise<AdminStats> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);

    const [
      total, deleted, unverified, admins, locked, activeLast30Days, newLast30Days,
      expenses, incomeSources, debts, goals, budgets, aiConversations,
    ] = await this.prisma.$transaction([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { deletedAt: { not: null } } }),
      this.prisma.user.count({ where: { deletedAt: null, emailVerified: false } }),
      this.prisma.user.count({ where: { deletedAt: null, role: 'ADMIN' } }),
      // Only a lock that has not yet expired counts: the column keeps its value
      // after the lockout lapses, so `not: null` would over-report indefinitely.
      this.prisma.user.count({ where: { deletedAt: null, lockedUntil: { gt: now } } }),
      this.prisma.user.count({ where: { deletedAt: null, lastLoginAt: { gte: thirtyDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.expense.count({ where: { deletedAt: null } }),
      this.prisma.incomeSource.count({ where: { deletedAt: null } }),
      this.prisma.debt.count({ where: { deletedAt: null } }),
      this.prisma.savingsGoal.count({ where: { deletedAt: null } }),
      this.prisma.budget.count(),
      this.prisma.aiConversation.count(),
    ]);

    return {
      users: {
        total,
        active: total - deleted,
        locked,
        deleted,
        unverified,
        admins,
        activeLast30Days,
        newLast30Days,
      },
      data: { expenses, incomeSources, debts, goals, budgets, aiConversations },
    };
  }

  async listUsers(query: AdminUserQuery): Promise<Paginated<AdminUserRow>> {
    const { search, role, status, cursor, limit } = query;
    const now = new Date();

    const where: Prisma.UserWhereInput = {
      ...(role ? { role } : {}),
      ...(search
        ? {
            OR: [
              { email: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(status === 'deleted' ? { deletedAt: { not: null } } : {}),
      ...(status === 'active' ? { deletedAt: null, OR: undefined } : {}),
      ...(status === 'locked' ? { deletedAt: null, lockedUntil: { gt: now } } : {}),
      ...(status === 'unverified' ? { deletedAt: null, emailVerified: false } : {}),
    };

    // A search combined with `status: active` would otherwise have its OR
    // clobbered by the spread above; rebuild it explicitly.
    if (status === 'active' && search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const rows = await this.prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map(toRow),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      total: await this.prisma.user.count({ where }),
    };
  }

  async findUser(id: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        timezone: true,
        locale: true,
        onboardingCompleted: true,
        tokensValidFrom: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const activity = await this.prisma.auditLog.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, action: true, entityType: true, createdAt: true, ipAddress: true },
    });

    return {
      ...toRow(user),
      timezone: user.timezone,
      locale: user.locale,
      onboardingCompleted: user.onboardingCompleted,
      tokensValidFrom: user.tokensValidFrom.toISOString(),
      recentActivity: activity.map((a) => ({
        id: a.id,
        action: a.action,
        entityType: a.entityType,
        createdAt: a.createdAt.toISOString(),
        ipAddress: a.ipAddress,
      })),
    };
  }

  async updateUser(
    actorId: string,
    id: string,
    input: AdminUpdateUserInput,
    context: { ip?: string | null; userAgent?: string | null; requestId?: string | null },
  ): Promise<AdminUserDetail> {
    const target = await this.requireUser(id);

    if (input.role !== undefined && input.role !== target.role) {
      // An admin changing their own role is the one edit that can strand the
      // console: the request succeeds, the next one is refused, and there may
      // be nobody left who can undo it. Demotion has to come from someone else.
      if (id === actorId) {
        throw new ForbiddenException(
          'You cannot change your own role. Ask another administrator to do it.',
        );
      }
      if (target.role === 'ADMIN') await this.assertNotLastAdmin(id, 'demote');
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.emailVerified !== undefined
          ? {
              emailVerified: input.emailVerified,
              emailVerifiedAt: input.emailVerified ? new Date() : null,
            }
          : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
      },
    });

    await this.afterMutation(actorId, id, 'UPDATE', context, {
      before: { role: target.role, emailVerified: target.emailVerified, name: target.name },
      after: { role: updated.role, emailVerified: updated.emailVerified, name: updated.name },
    });

    return this.findUser(id);
  }

  /**
   * Clears a failed-login lockout.
   *
   * The counter is reset alongside the timestamp. Clearing only `lockedUntil`
   * leaves the count at its threshold, so the next single failure re-locks the
   * account and the unlock looks like it silently did nothing.
   */
  async unlockUser(actorId: string, id: string, context: MutationContext): Promise<AdminUserDetail> {
    await this.requireUser(id);
    await this.prisma.user.update({
      where: { id },
      data: { lockedUntil: null, failedLoginAttempts: 0 },
    });
    await this.afterMutation(actorId, id, 'UPDATE', context, { unlocked: true });
    return this.findUser(id);
  }

  /**
   * Revokes every session by moving the token cut-off to now, which invalidates
   * outstanding refresh tokens without scanning the token table.
   */
  async forceLogout(actorId: string, id: string, context: MutationContext): Promise<AdminUserDetail> {
    await this.requireUser(id);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { tokensValidFrom: new Date() } }),
      this.prisma.refreshToken.deleteMany({ where: { userId: id } }),
    ]);
    await this.afterMutation(actorId, id, 'LOGOUT', context, { forcedByAdmin: true });
    return this.findUser(id);
  }

  /**
   * Soft-deletes an account. The rows stay, so this is reversible by `restore`
   * and does not silently destroy someone's financial history on a misclick.
   */
  async deleteUser(actorId: string, id: string, context: MutationContext): Promise<void> {
    const target = await this.requireUser(id);
    if (target.deletedAt) return;

    if (id === actorId) {
      throw new ForbiddenException('You cannot delete your own account from the admin console.');
    }
    if (target.role === 'ADMIN') await this.assertNotLastAdmin(id, 'delete');

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        // Sessions die with the account; a soft-deleted user must not keep a
        // working access token until it happens to expire.
        data: { deletedAt: new Date(), tokensValidFrom: new Date() },
      }),
      this.prisma.refreshToken.deleteMany({ where: { userId: id } }),
    ]);

    await this.afterMutation(actorId, id, 'DELETE', context, { email: target.email });
  }

  async restoreUser(actorId: string, id: string, context: MutationContext): Promise<AdminUserDetail> {
    const target = await this.requireUser(id);
    if (!target.deletedAt) throw new BadRequestException('That account is not deleted.');

    await this.prisma.user.update({ where: { id }, data: { deletedAt: null } });
    await this.afterMutation(actorId, id, 'UPDATE', context, { restored: true });
    return this.findUser(id);
  }

  private async requireUser(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Refuses an action that would leave no administrator behind.
   *
   * Note this cannot currently fire: every actor here is an ADMIN, a caller is
   * already barred from acting on themselves, so the actor always counts among
   * the remaining admins. What actually preserves the invariant today is the
   * self-action block above.
   *
   * It is kept because that reasoning is a property of the current access
   * rules, not of this method. Widen the controller beyond ADMIN, or add a
   * service account that can manage users, and total lockout becomes reachable
   * — recoverable only by hand-editing the database.
   */
  private async assertNotLastAdmin(id: string, verb: 'demote' | 'delete'): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { role: 'ADMIN', deletedAt: null, id: { not: id } },
    });
    if (remaining === 0) {
      throw new BadRequestException(
        `This is the only administrator left, so it cannot be ${verb}d. ` +
          'Promote another account first.',
      );
    }
  }

  /** Audit the action and drop the target's cached reads in one place. */
  private async afterMutation(
    actorId: string,
    targetId: string,
    action: 'UPDATE' | 'DELETE' | 'LOGOUT',
    context: MutationContext,
    changes: Record<string, unknown>,
  ): Promise<void> {
    await this.redis.invalidateUser(targetId);
    // Recorded against the acting administrator, not the target: the question
    // an audit log has to answer is who did this, and a row attributed to the
    // affected user reads as though they did it to themselves.
    await this.audit.record({
      userId: actorId,
      action,
      entityType: 'User',
      entityId: targetId,
      changes: { targetUserId: targetId, ...changes },
      ipAddress: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
    });
    this.logger.log(`admin ${actorId} performed ${action} on user ${targetId}`);
  }
}

interface MutationContext {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}
