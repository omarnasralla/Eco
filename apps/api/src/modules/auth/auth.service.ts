import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import type {
  ChangePasswordInput,
  LoginInput,
  LoginResponseDto,
  RegisterInput,
  UserDto,
} from '@eco/shared';
import { DEFAULT_CATEGORIES } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { generateToken, hashToken } from '../../common/utils/crypto';
import { MailService } from '../mail/mail.service';
import { TokenService, type IssueContext } from './token.service';
import { TwoFactorService } from './two-factor.service';
import { toUserDto } from '../users/user.mapper';

/**
 * Argon2id parameters. 64 MiB and 3 passes is the OWASP recommendation and
 * costs roughly 50 ms on modern server hardware — slow enough to make offline
 * cracking expensive, fast enough that a login does not feel sluggish.
 */
const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly twoFactor: TwoFactorService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async register(input: RegisterInput, context: IssueContext = {}): Promise<LoginResponseDto> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      // Do not confirm that the address is taken — that is a free account
      // enumeration oracle. Tell the real owner instead, by email.
      await this.mail.sendDuplicateRegistrationNotice(input.email);
      throw new BadRequestException(
        'If that address can be registered, we have sent a verification email.',
      );
    }

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash: await argon2.hash(input.password, ARGON_OPTIONS),
          name: input.name,
          country: input.country ?? null,
          currency: input.currency,
          timezone: input.timezone,
        },
      });

      // Seed the twelve default categories so the first expense the user
      // records has somewhere to go. Housing/utilities/healthcare/insurance
      // are marked essential — that flag drives the emergency-fund target.
      const essentials = new Set(['housing', 'utilities', 'healthcare', 'insurance', 'transportation']);
      await tx.category.createMany({
        data: DEFAULT_CATEGORIES.map((c, index) => ({
          userId: created.id,
          name: c.name,
          slug: c.slug,
          icon: c.icon,
          color: c.color,
          isSystem: true,
          isEssential: essentials.has(c.slug),
          sortOrder: index,
        })),
      });

      await tx.notificationPreference.create({ data: { userId: created.id } });
      return created;
    });

    await this.sendVerificationEmail(user.id, user.email, user.name);
    this.logger.log(`Registered user ${user.id}`);

    return {
      user: toUserDto(user),
      tokens: await this.tokens.issueTokens(user, context),
    };
  }

  async login(input: LoginInput, context: IssueContext = {}): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });

    // Hash against a dummy value when the account does not exist, so a missing
    // account and a wrong password take the same time to answer.
    if (!user?.passwordHash) {
      await argon2.hash(input.password, ARGON_OPTIONS).catch(() => undefined);
      throw new UnauthorizedException('Email or password is incorrect');
    }

    if (user.deletedAt) {
      throw new UnauthorizedException('Email or password is incorrect');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new ForbiddenException(
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }

    if (!(await argon2.verify(user.passwordHash, input.password))) {
      await this.recordFailedLogin(user.id, user.failedLoginAttempts);
      throw new UnauthorizedException('Email or password is incorrect');
    }

    if (user.twoFactorEnabled) {
      if (!input.totpCode) {
        // Signal the client to collect a code. A short-lived challenge token
        // proves the password step already succeeded without issuing a session.
        return {
          twoFactorRequired: true,
          challengeToken: await this.createChallengeToken(user.id),
        };
      }
      if (!(await this.twoFactor.verify(user.id, input.totpCode))) {
        await this.recordFailedLogin(user.id, user.failedLoginAttempts);
        throw new UnauthorizedException('That two-factor code is not valid');
      }
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    return {
      user: toUserDto(user),
      tokens: await this.tokens.issueTokens(user, context),
    };
  }

  /** Second leg of a 2FA login: challenge token plus TOTP code. */
  async completeTwoFactorLogin(
    challengeToken: string,
    totpCode: string,
    context: IssueContext = {},
  ): Promise<LoginResponseDto> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(challengeToken) },
      include: { user: true },
    });

    if (!record || record.purpose !== 'TWO_FACTOR_CHALLENGE' || record.usedAt) {
      throw new UnauthorizedException('That sign-in attempt is no longer valid');
    }
    if (record.expiresAt < new Date()) {
      throw new UnauthorizedException('That sign-in attempt has expired — please start again');
    }
    if (!(await this.twoFactor.verify(record.userId, totpCode))) {
      await this.recordFailedLogin(record.userId, record.user.failedLoginAttempts);
      throw new UnauthorizedException('That two-factor code is not valid');
    }

    await this.prisma.$transaction([
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: record.userId },
        data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
      }),
    ]);

    return {
      user: toUserDto(record.user),
      tokens: await this.tokens.issueTokens(record.user, context),
    };
  }

  /**
   * Progressive lockout. Repeated failures freeze the account for 15 minutes,
   * which stops credential stuffing without letting an attacker lock a victim
   * out permanently by guessing at their address.
   */
  private async recordFailedLogin(userId: string, currentAttempts: number): Promise<void> {
    const attempts = currentAttempts + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil:
          attempts >= MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      },
    });

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      this.logger.warn(`Account ${userId} locked after ${attempts} failed attempts`);
    }
  }

  private async createChallengeToken(userId: string): Promise<string> {
    const token = generateToken(32);
    await this.prisma.verificationToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        purpose: 'TWO_FACTOR_CHALLENGE',
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    return token;
  }

  async sendVerificationEmail(userId: string, email: string, name: string): Promise<void> {
    const token = generateToken(32);
    await this.prisma.verificationToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        purpose: 'EMAIL_VERIFICATION',
        expiresAt: new Date(Date.now() + 24 * 3_600 * 1000),
      },
    });

    const url = `${this.config.getOrThrow<string>('webOrigin')}/verify-email?token=${token}`;
    await this.mail.sendVerificationEmail(email, name, url);
  }

  async verifyEmail(token: string): Promise<void> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    if (!record || record.purpose !== 'EMAIL_VERIFICATION' || record.usedAt) {
      throw new BadRequestException('That verification link is not valid');
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('That verification link has expired');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: { emailVerified: true, emailVerifiedAt: new Date() },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);
  }

  /**
   * Always reports success, whether or not the address exists. Anything else
   * turns the reset form into an account-enumeration endpoint.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.deletedAt) return;

    const token = generateToken(32);
    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        purpose: 'PASSWORD_RESET',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });

    const url = `${this.config.getOrThrow<string>('webOrigin')}/reset-password?token=${token}`;
    await this.mail.sendPasswordResetEmail(user.email, user.name, url);
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const record = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!record || record.purpose !== 'PASSWORD_RESET' || record.usedAt) {
      throw new BadRequestException('That reset link is not valid');
    }
    if (record.expiresAt < new Date()) {
      throw new BadRequestException('That reset link has expired');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash: await argon2.hash(newPassword, ARGON_OPTIONS),
          // Kills every existing session: if the reset was triggered because
          // the account was compromised, the attacker's session dies here.
          tokensValidFrom: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
    ]);

    await this.tokens.revokeAllForUser(record.userId);
    await this.mail.sendPasswordChangedNotice(record.user.email, record.user.name);
  }

  async changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) {
      throw new BadRequestException(
        'This account signs in with a social provider and has no password to change.',
      );
    }
    if (!(await argon2.verify(user.passwordHash, input.currentPassword))) {
      throw new UnauthorizedException('Your current password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await argon2.hash(input.newPassword, ARGON_OPTIONS),
        tokensValidFrom: new Date(),
      },
    });

    await this.tokens.revokeAllForUser(userId);
    await this.mail.sendPasswordChangedNotice(user.email, user.name);
  }

  /** Finds or creates a user from a verified OAuth profile. */
  async handleOAuthLogin(
    provider: 'GOOGLE' | 'APPLE' | 'MICROSOFT',
    profile: { providerUserId: string; email: string; name: string },
    context: IssueContext = {},
  ): Promise<LoginResponseDto> {
    const existingLink = await this.prisma.oAuthAccount.findUnique({
      where: { provider_providerUserId: { provider, providerUserId: profile.providerUserId } },
      include: { user: true },
    });

    if (existingLink) {
      return {
        user: toUserDto(existingLink.user),
        tokens: await this.tokens.issueTokens(existingLink.user, context),
      };
    }

    const user = await this.prisma.$transaction(async (tx) => {
      // Link to an existing local account with the same address. The provider
      // has already verified ownership of that mailbox, so this is safe — and
      // it prevents a confusing duplicate account.
      let target = await tx.user.findUnique({ where: { email: profile.email } });

      if (!target) {
        target = await tx.user.create({
          data: {
            email: profile.email,
            name: profile.name,
            // No password: this account can only be reached through OAuth
            // until the user sets one via the reset flow.
            passwordHash: null,
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });

        const essentials = new Set(['housing', 'utilities', 'healthcare', 'insurance', 'transportation']);
        await tx.category.createMany({
          data: DEFAULT_CATEGORIES.map((c, index) => ({
            userId: target!.id,
            name: c.name,
            slug: c.slug,
            icon: c.icon,
            color: c.color,
            isSystem: true,
            isEssential: essentials.has(c.slug),
            sortOrder: index,
          })),
        });
        await tx.notificationPreference.create({ data: { userId: target.id } });
      }

      await tx.oAuthAccount.create({
        data: { userId: target.id, provider, providerUserId: profile.providerUserId },
      });

      return target;
    });

    return { user: toUserDto(user), tokens: await this.tokens.issueTokens(user, context) };
  }

  async me(userId: string): Promise<UserDto> {
    return toUserDto(await this.prisma.user.findUniqueOrThrow({ where: { id: userId } }));
  }
}
