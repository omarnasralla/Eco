import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@eco/shared';

export const ROLES_KEY = 'roles';

/** Restricts a route to the listed roles; enforced by RolesGuard. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
