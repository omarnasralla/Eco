import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { JwtPayload } from '../token.service';

/**
 * Validates the access token on every request.
 *
 * A valid signature is not sufficient. We also confirm the account still exists,
 * is not deleted, and that the token was issued *after* the account's
 * `tokensValidFrom` watermark — that watermark is how a password change or
 * "log out everywhere" kills access tokens that have not yet expired.
 *
 * That check needs the user row, so it is cached in Redis for 60 seconds:
 * short enough that a revocation takes effect almost immediately, long enough
 * to keep a hot endpoint off the database on every single call.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('jwt.accessSecret'),
      issuer: config.getOrThrow<string>('jwt.issuer'),
      audience: config.getOrThrow<string>('jwt.audience'),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const cacheKey = `auth:user:${payload.sub}`;

    const user = await this.redis.remember(cacheKey, 60, async () =>
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          role: true,
          currency: true,
          timezone: true,
          deletedAt: true,
          tokensValidFrom: true,
        },
      }),
    );

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Account is no longer active');
    }

    // JWT `iat` is whole seconds (RFC 7519), while `tokensValidFrom` carries
    // millisecond precision. Comparing them directly rejects a token issued at
    // 12:00:00.4 against a watermark of 12:00:00.750 — which is every token
    // handed out at registration or immediately after a password change.
    // Truncate the watermark to the same second-granularity as the claim.
    // The cost is a sub-second window in which a token minted in the very
    // same second as a revocation stays valid; the refresh token is revoked
    // outright, so that window cannot be extended.
    const issuedAtSeconds = payload.iat ?? 0;
    const validFromSeconds = Math.floor(new Date(user.tokensValidFrom).getTime() / 1000);
    if (issuedAtSeconds < validFromSeconds) {
      throw new UnauthorizedException('Session is no longer valid — please sign in again');
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      currency: user.currency,
      timezone: user.timezone,
    };
  }
}
