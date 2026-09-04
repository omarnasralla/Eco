import type { User } from '@prisma/client';
import type { UserDto } from '@eco/shared';

/**
 * Prisma row → API DTO.
 *
 * Mapping is explicit rather than a spread, because a spread would happily ship
 * `passwordHash`, `twoFactorSecret` and `twoFactorRecoveryCodes` to the client
 * the moment someone adds a field. Listing every field means a new secret
 * column is invisible to the API until somebody deliberately adds it here.
 */
export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    country: user.country,
    currency: user.currency,
    secondaryCurrency: user.secondaryCurrency,
    timezone: user.timezone,
    locale: user.locale,
    emailVerified: user.emailVerified,
    twoFactorEnabled: user.twoFactorEnabled,
    financialGoals: (user.financialGoals as Record<string, unknown> | null) ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}
