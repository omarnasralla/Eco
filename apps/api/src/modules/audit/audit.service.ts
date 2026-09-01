import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';

export interface AuditEntry {
  userId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  changes?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** Keys whose values must never reach the audit log, matched case-insensitively. */
const REDACTED_KEYS = /pass(word)?|secret|token|hash|otp|totp|recovery|authorization|cookie/i;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an append-only audit record.
   *
   * Never throws: an audit write failing must not roll back the user's actual
   * operation. A missing log line is a monitoring problem; a failed expense
   * save because logging hiccuped is a product problem.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          changes: entry.changes ? (this.redact(entry.changes) as never) : undefined,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent?.slice(0, 400) ?? null,
          requestId: entry.requestId ?? null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write audit entry: ${(error as Error).message}`);
    }
  }

  /** Recursively replaces sensitive values with a marker. */
  private redact(value: unknown, depth = 0): unknown {
    if (depth > 6 || value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1));

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        REDACTED_KEYS.test(key) ? '[redacted]' : this.redact(val, depth + 1),
      ]),
    );
  }

  /** The user's own audit trail, for the security page. */
  async findForUser(userId: string, limit = 100) {
    const entries = await this.prisma.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        ipAddress: true,
        createdAt: true,
      },
    });

    return entries.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      ipAddress: e.ipAddress,
      createdAt: e.createdAt.toISOString(),
    }));
  }
}
