import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

export const INGEST_HEADER = 'x-eco-token';

/**
 * Authenticates a capture token instead of a JWT.
 *
 * A shortcut on a phone cannot refresh an access token, so it needs a
 * credential that does not expire — which is exactly why this one can do so
 * little: it authenticates `POST /ingest/expenses` and nothing else. It is not
 * a session, and the routes that manage these tokens still require a real one.
 *
 * The token carries its owner (`eco_<user>_<secret>`) so the row is found by
 * tenant rather than by scanning every secret in the table. That also keeps
 * the lookup working under row-level security, where a query must know whose
 * data it is reading before it reads it.
 */
@Injectable()
export class IngestTokenGuard implements CanActivate {
  private readonly logger = new Logger(IngestTokenGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const header = req.headers[INGEST_HEADER];
    const presented = Array.isArray(header) ? header[0] : header;
    if (!presented) {
      this.logger.warn(`capture auth failed reason=no-header expected=${INGEST_HEADER}`);
      throw new UnauthorizedException('Missing capture token');
    }

    const userId = userIdFrom(presented);
    if (!userId) {
      // Length and shape only — never the token itself.
      this.logger.warn(
        `capture auth failed reason=malformed length=${presented.length} ` +
          `prefix=${presented.slice(0, 4)} parts=${presented.split('_').length}`,
      );
      throw new UnauthorizedException('Malformed capture token');
    }

    const tokenHash = createHash('sha256').update(presented).digest('hex');
    const token = await this.prisma.ingestToken.findFirst({
      where: { tokenHash, userId, revokedAt: null },
      select: { id: true, user: { select: { id: true, currency: true, deletedAt: true } } },
    });
    // One message for every failure: a revoked token and a wrong one should be
    // indistinguishable to whoever is holding the wrong one.
    if (!token || token.user.deletedAt) {
      // Which of the two it is matters a great deal to whoever is debugging:
      // "revoked" means the shortcut holds an old token, "unknown" means it
      // holds one this server never issued.
      const revoked = await this.prisma.ingestToken.findFirst({
        where: { tokenHash, userId },
        select: { label: true, revokedAt: true },
      });
      this.logger.warn(
        `capture auth failed reason=${revoked ? 'revoked' : 'unknown-token'} user=${userId}` +
          (revoked?.revokedAt ? ` revokedAt=${revoked.revokedAt.toISOString()}` : ''),
      );
      throw new UnauthorizedException('Invalid capture token');
    }

    req.user = { id: token.user.id, currency: token.user.currency } as AuthenticatedUser;

    // Not awaited, and failure is ignored: "when did this phone last post" is
    // useful, but it is not worth failing a capture over.
    void this.prisma.ingestToken
      .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }
}

/**
 * The user id embedded in a token, or null if this is not one of ours.
 *
 * Hex without dashes, so the token stays one selectable word on a phone.
 */
export function userIdFrom(token: string): string | null {
  // Anchored on the secret as "everything after the second underscore", NOT a
  // three-way split: base64url's alphabet includes '_', so roughly half of all
  // generated tokens split into four parts or more and were read as malformed.
  const match = /^eco_([0-9a-f]{32})_(.+)$/.exec(token);
  if (!match) return null;
  const hex = match[1];
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
