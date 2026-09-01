import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a route as reachable without a JWT. Authentication is on by default
 * globally, so forgetting this decorator fails closed (401) rather than open.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
