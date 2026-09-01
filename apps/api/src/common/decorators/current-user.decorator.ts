import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  currency: string;
  timezone: string;
}

/**
 * Injects the authenticated user, or one of its fields:
 *   findAll(@CurrentUser('id') userId: string)
 *
 * Every service method takes the user id as an explicit argument rather than
 * reading ambient state — it makes the tenant boundary visible in each
 * signature, and makes services trivially unit-testable.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
