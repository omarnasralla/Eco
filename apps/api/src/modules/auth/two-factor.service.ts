import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as argon2 from 'argon2';
import * as QRCode from 'qrcode';
import type { TwoFactorSetupDto } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt, encrypt, generateRecoveryCodes } from '../../common/utils/crypto';

/**
 * TOTP-based two-factor authentication (RFC 6238).
 *
 * The shared secret is encrypted at rest with AES-256-GCM — a database dump
 * alone must not let an attacker generate valid codes. Recovery codes are
 * Argon2-hashed like passwords and consumed on use.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // One step of clock drift either way. Wider windows meaningfully extend
    // the replay surface for a code an attacker has shoulder-surfed.
    authenticator.options = { window: 1 };
  }

  private get key(): Buffer {
    return this.config.getOrThrow<Buffer>('encryption.key');
  }

  /**
   * Generates a secret and provisioning QR code. 2FA is NOT enabled yet — the
   * user must first prove they can produce a valid code, otherwise a misscanned
   * QR would lock them out of their own account permanently.
   */
  async beginSetup(userId: string, email: string): Promise<TwoFactorSetupDto> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled');
    }

    const secret = authenticator.generateSecret();
    const issuer = this.config.getOrThrow<string>('totp.issuer');
    const otpauthUrl = authenticator.keyuri(email, issuer, secret);

    const recoveryCodes = generateRecoveryCodes(10);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorSecret: encrypt(secret, this.key, this.config.get<number>('encryption.version')),
        twoFactorRecoveryCodes: await Promise.all(
          recoveryCodes.map((code) => argon2.hash(code, { type: argon2.argon2id })),
        ),
      },
    });

    return {
      secret,
      otpauthUrl,
      qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl),
      // Shown exactly once. We only ever store the hashes.
      recoveryCodes,
    };
  }

  /** Confirms setup by verifying the first code the user produces. */
  async confirmSetup(userId: string, totpCode: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorSecret) {
      throw new BadRequestException('Start two-factor setup before confirming it');
    }

    const secret = decrypt(user.twoFactorSecret, this.key);
    if (!authenticator.verify({ token: totpCode, secret })) {
      throw new UnauthorizedException('That code is not valid — check your authenticator app');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });
  }

  async verify(userId: string, totpCode: string): Promise<boolean> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecret) return true;

    const secret = decrypt(user.twoFactorSecret, this.key);
    if (authenticator.verify({ token: totpCode, secret })) return true;

    // Fall back to recovery codes, which are single-use.
    return this.consumeRecoveryCode(userId, totpCode, user.twoFactorRecoveryCodes);
  }

  private async consumeRecoveryCode(
    userId: string,
    candidate: string,
    hashes: string[],
  ): Promise<boolean> {
    const normalised = candidate.trim().toUpperCase();

    for (const hash of hashes) {
      if (await argon2.verify(hash, normalised)) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { twoFactorRecoveryCodes: hashes.filter((h) => h !== hash) },
        });
        return true;
      }
    }
    return false;
  }

  /**
   * Disabling 2FA requires the current password. Without that check, a
   * momentarily unlocked device is enough to strip the account's second factor.
   */
  async disable(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Password is incorrect');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorRecoveryCodes: [],
      },
    });
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes(10);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorRecoveryCodes: await Promise.all(
          codes.map((code) => argon2.hash(code, { type: argon2.argon2id })),
        ),
      },
    });
    return codes;
  }
}
