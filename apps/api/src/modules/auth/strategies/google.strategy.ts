import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile, type VerifyCallback } from 'passport-google-oauth20';

/**
 * Google OAuth 2.0. Apple and Microsoft follow the same shape — each maps its
 * provider profile onto the common `{ providerUserId, email, name }` triple
 * that AuthService.handleOAuthLogin consumes, so adding a provider touches only
 * its own strategy file.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService) {
    super({
      clientID: config.get<string>('oauth.google.clientId') ?? 'not-configured',
      clientSecret: config.get<string>('oauth.google.clientSecret') ?? 'not-configured',
      callbackURL: config.get<string>('oauth.google.callbackUrl') ?? 'not-configured',
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      // Without an address we cannot link or create an account.
      done(new Error('Google did not return an email address'), false);
      return;
    }

    done(null, {
      providerUserId: profile.id,
      email: email.toLowerCase(),
      name: profile.displayName || email.split('@')[0] || 'User',
    });
  }
}
