import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma client wired into the Nest lifecycle.
 *
 * `withTenant` is the important part: it opens a transaction, sets
 * `app.current_user_id` on that connection, and runs the callback inside it.
 * The Postgres RLS policies read that setting, so any query that forgets its
 * `where: { userId }` returns nothing instead of another user's data. The
 * setting is transaction-scoped (`set_config(..., true)`), so a pooled
 * connection cannot carry one user's identity into the next request.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Runs `fn` with Postgres row-level security scoped to one user. */
  async withTenant<T>(userId: string, fn: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx as PrismaTransaction);
    });
  }

  /**
   * Hard-deletes every trace of a user, for GDPR Article 17 erasure.
   * Cascades handle the owned rows; the audit log is detached rather than
   * deleted, because we are legally required to retain security events —
   * anonymising the subject satisfies both obligations.
   */
  async purgeUser(userId: string): Promise<void> {
    await this.$transaction([
      this.auditLog.updateMany({ where: { userId }, data: { userId: null } }),
      this.user.delete({ where: { id: userId } }),
    ]);
    this.logger.warn(`Purged all data for user ${userId}`);
  }
}

/** The transaction-scoped client handed to `withTenant` callbacks. */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
