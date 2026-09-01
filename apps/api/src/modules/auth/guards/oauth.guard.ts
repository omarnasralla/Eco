import {
  ExecutionContext,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';

/**
 * Passport's guard resolves its strategy before the route handler runs, so a
 * provider that was never registered surfaces as an opaque 500 ("Unknown
 * authentication strategy"). Checking configuration here — ahead of that
 * lookup — turns a missing client ID into an honest 501 instead.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard('google') {
  constructor(private readonly config: ConfigService) {
    super();
  }

  override canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    if (!this.config.get<boolean>('oauth.google.enabled')) {
      throw new NotImplementedException(
        'Google sign-in is not configured on this deployment.',
      );
    }
    return super.canActivate(context);
  }
}
