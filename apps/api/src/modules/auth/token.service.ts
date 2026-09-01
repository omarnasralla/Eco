import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { AuthTokensDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { generateToken, hashToken } from '../../common/utils/crypto';

export interface JwtPayload {
  /** Subject — the user id. */
  sub: string;
  email: string;
  role: string;
  /** Issued-at, in seconds. Compared against `user.tokensValidFrom`. */
  iat?: number;
  exp?: number;
}

export interface IssueContext {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}

/**
 * Refresh-token rotation with reuse detection.
 *
 * Every refresh returns a brand-new token and retires the old one. Tokens are
 * linked by `familyId`, which is what makes theft detectable: if a *retired*
 * token from a family is ever presented again, either the legitimate client is
 * replaying or an attacker has a stolen copy — and we cannot tell which. So the
 * entire family is revoked and both parties are forced to log in again. That is
 * the standard OAuth 2.0 BCP response, and it turns a silent, indefinite
 * compromise into a single visible logout.
 *
 * Only SHA-256 digests are stored, so a database leak yields nothing usable.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async issueTokens(
    user: { id: string; email: string; role: string },
    context: IssueContext = {},
    familyId: string = randomUUID(),
  ): Promise<AuthTokensDto> {
    const accessTtl = this.config.getOrThrow<number>('jwt.accessTtl');

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, email: user.email, role: user.role },
      {
        secret: this.config.getOrThrow<string>('jwt.accessSecret'),
        expiresIn: accessTtl,
        issuer: this.config.getOrThrow<string>('jwt.issuer'),
        audience: this.config.getOrThrow<string>('jwt.audience'),
      },
    );

    // The refresh token is opaque random bytes, not a JWT. It is only ever
    // presented to one endpoint, so it needs no self-describing claims — and
    // an opaque token cannot be decoded by anyone who intercepts it.
    const refreshToken = generateToken(48);
    const refreshTtl = this.config.getOrThrow<number>('jwt.refreshTtl');

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        userAgent: context.userAgent?.slice(0, 400) ?? null,
        ipAddress: context.ipAddress ?? null,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });

    return { accessToken, refreshToken, expiresIn: accessTtl, tokenType: 'Bearer' };
  }

  /** Validates, rotates, and returns a fresh pair. Throws on reuse. */
  async rotate(refreshToken: string, context: IssueContext = {}): Promise<AuthTokensDto> {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new ForbiddenException('Invalid refresh token');
    }

    if (stored.revokedAt) {
      // A retired token came back. Assume compromise and burn the family.
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; revoking family ${stored.familyId}`,
      );
      await this.revokeFamily(stored.familyId);
      throw new ForbiddenException('Refresh token reuse detected — please sign in again');
    }

    if (stored.expiresAt < new Date()) {
      throw new ForbiddenException('Refresh token expired');
    }

    // Password change or "log out everywhere" invalidates everything older.
    if (stored.createdAt < stored.user.tokensValidFrom) {
      await this.revokeFamily(stored.familyId);
      throw new ForbiddenException('Session is no longer valid — please sign in again');
    }

    if (stored.user.deletedAt) {
      throw new ForbiddenException('Account is no longer active');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(stored.user, context, stored.familyId);
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** "Log out everywhere". Also bumps `tokensValidFrom` to catch live sessions. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { tokensValidFrom: new Date() },
      }),
    ]);
  }

  /** Active sessions, for the security page in settings. */
  async listSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Housekeeping: drop expired and long-revoked rows. Runs nightly. */
  async pruneExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 30 * 24 * 3_600 * 1000);
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }],
      },
    });
    return count;
  }
}
