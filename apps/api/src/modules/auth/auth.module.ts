import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { TwoFactorService } from './two-factor.service';
import { GoogleOAuthGuard } from './guards/oauth.guard';
import { GoogleStrategy } from './strategies/google.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule.register({ session: false }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.getOrThrow<number>('jwt.accessTtl') },
      }),
    }),
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    TwoFactorService,
    JwtStrategy,
    GoogleOAuthGuard,
    {
      // Passport validates its options in the constructor, so instantiating
      // this without real credentials crashes the whole application at boot.
      // Only construct it when Google is actually configured; the OAuth routes
      // report 501 otherwise (see GoogleOAuthGuard).
      provide: GoogleStrategy,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (!config.get<boolean>('oauth.google.enabled')) {
          new Logger('AuthModule').warn(
            'Google OAuth is not configured; /auth/oauth/google is disabled.',
          );
          return null;
        }
        return new GoogleStrategy(config);
      },
    },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
