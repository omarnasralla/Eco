import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  changePasswordSchema,
  enable2faSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type ChangePasswordInput,
  type LoginInput,
  type RegisterInput,
} from '@eco/shared';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { GoogleOAuthGuard } from './guards/oauth.guard';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { TwoFactorService } from './two-factor.service';

/** Client IP and user agent, recorded against each session for the security page. */
function issueContext(req: Request) {
  return {
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly twoFactor: TwoFactorService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('register')
  @Throttle({ auth: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Create an account and receive a token pair' })
  async register(
    @Body(zodBody(registerSchema)) dto: RegisterInput,
    @Req() req: Request,
  ) {
    return this.auth.register(dto, issueContext(req));
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in; may return a two-factor challenge' })
  async login(@Body(zodBody(loginSchema)) dto: LoginInput, @Req() req: Request) {
    return this.auth.login(dto, issueContext(req));
  }

  @Public()
  @Post('login/2fa')
  @HttpCode(HttpStatus.OK)
  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Complete a two-factor sign-in' })
  async loginTwoFactor(
    @Body() body: { challengeToken: string; totpCode: string },
    @Req() req: Request,
  ) {
    return this.auth.completeTwoFactorLogin(
      body.challengeToken,
      body.totpCode,
      issueContext(req),
    );
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new pair (rotating)' })
  async refresh(@Body(zodBody(refreshSchema)) dto: { refreshToken: string }, @Req() req: Request) {
    return this.tokens.rotate(dto.refreshToken, issueContext(req));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('LOGOUT', 'User')
  @ApiOperation({ summary: 'Revoke the presented refresh token' })
  async logout(@Body() body: { refreshToken?: string }): Promise<void> {
    if (body.refreshToken) await this.tokens.revoke(body.refreshToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('LOGOUT', 'User')
  @ApiOperation({ summary: 'Sign out of every device' })
  async logoutAll(@CurrentUser('id') userId: string): Promise<void> {
    await this.tokens.revokeAllForUser(userId);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions' })
  async sessions(@CurrentUser('id') userId: string) {
    return this.tokens.listSessions(userId);
  }

  @Get('me')
  @ApiOperation({ summary: 'The signed-in user' })
  async me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm an email address' })
  async verifyEmail(@Body(zodBody(verifyEmailSchema)) dto: { token: string }): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ auth: { limit: 3, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Send the verification email again' })
  async resendVerification(@CurrentUser() user: { id: string; email: string }): Promise<void> {
    const profile = await this.auth.me(user.id);
    await this.auth.sendVerificationEmail(user.id, profile.email, profile.name);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ auth: { limit: 5, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Request a password-reset email (always 204)' })
  async forgotPassword(@Body(zodBody(forgotPasswordSchema)) dto: { email: string }): Promise<void> {
    await this.auth.requestPasswordReset(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ auth: { limit: 5, ttl: 3_600_000 } })
  @Audit('PASSWORD_RESET', 'User')
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  async resetPassword(
    @Body(zodBody(resetPasswordSchema)) dto: { token: string; password: string },
  ): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.password);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('UPDATE', 'User')
  @ApiOperation({ summary: 'Change the password of the signed-in user' })
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body(zodBody(changePasswordSchema)) dto: ChangePasswordInput,
  ): Promise<void> {
    await this.auth.changePassword(userId, dto);
  }

  // ── Two-factor ──────────────────────────────────────────────────────────

  @Post('2fa/setup')
  @ApiOperation({ summary: 'Begin TOTP enrolment; returns a QR code' })
  async begin2fa(@CurrentUser() user: { id: string; email: string }) {
    return this.twoFactor.beginSetup(user.id, user.email);
  }

  @Post('2fa/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('TWO_FA_ENABLED', 'User')
  @ApiOperation({ summary: 'Confirm enrolment with a valid code' })
  async enable2fa(
    @CurrentUser('id') userId: string,
    @Body(zodBody(enable2faSchema)) dto: { totpCode: string },
  ): Promise<void> {
    await this.twoFactor.confirmSetup(userId, dto.totpCode);
  }

  @Post('2fa/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('TWO_FA_DISABLED', 'User')
  @ApiOperation({ summary: 'Turn off two-factor (requires the password)' })
  async disable2fa(
    @CurrentUser('id') userId: string,
    @Body() body: { password: string },
  ): Promise<void> {
    await this.twoFactor.disable(userId, body.password);
  }

  @Post('2fa/recovery-codes')
  @ApiOperation({ summary: 'Regenerate recovery codes (invalidates the old set)' })
  async regenerateRecoveryCodes(@CurrentUser('id') userId: string) {
    return { recoveryCodes: await this.twoFactor.regenerateRecoveryCodes(userId) };
  }

  // ── OAuth ───────────────────────────────────────────────────────────────

  @Public()
  @Get('oauth/google')
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Start the Google OAuth flow' })
  googleAuth(): void {
    // Passport issues the redirect; this body is never reached.
  }

  @Public()
  @Get('oauth/google/callback')
  @UseGuards(GoogleOAuthGuard)
  @ApiOperation({ summary: 'Google OAuth callback' })
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const profile = req.user as { providerUserId: string; email: string; name: string };
    const result = await this.auth.handleOAuthLogin('GOOGLE', profile, issueContext(req));

    // Hand the tokens back through a one-time fragment rather than a query
    // string: fragments are not sent to servers and stay out of access logs,
    // proxy logs and the Referer header.
    const webOrigin = this.config.getOrThrow<string>('webOrigin');
    const params = new URLSearchParams({
      access_token: result.tokens!.accessToken,
      refresh_token: result.tokens!.refreshToken,
      expires_in: String(result.tokens!.expiresIn),
    });
    res.redirect(`${webOrigin}/auth/callback#${params.toString()}`);
  }
}
