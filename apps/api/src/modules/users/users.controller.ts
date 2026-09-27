import { Body, Controller, Delete, Get, Patch, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { updateProfileSchema, type UpdateProfileInput } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the current profile' })
  async me(@CurrentUser('id') userId: string) {
    return this.users.findById(userId);
  }

  @Patch('me')
  @Audit('UPDATE', 'User')
  @ApiOperation({ summary: 'Update profile, currency, timezone or goals' })
  async update(
    @CurrentUser('id') userId: string,
    @Body(zodBody(updateProfileSchema)) dto: UpdateProfileInput,
  ) {
    return this.users.updateProfile(userId, dto);
  }

  @Post('me/onboarding/complete')
  @ApiOperation({ summary: 'Mark onboarding as finished' })
  async completeOnboarding(@CurrentUser('id') userId: string) {
    await this.users.completeOnboarding(userId);
    return { onboardingCompleted: true };
  }

  @Get('me/export')
  // Same bucket and ceiling as report generation: this reads every table the
  // user owns, so it is not something to allow on a loop. The ceiling in
  // app.module is deliberately unreachable — this is the real limit.
  @Throttle({ export: { limit: 20, ttl: 3_600_000 } })
  @Audit('EXPORT', 'User')
  @ApiOperation({ summary: 'Download every record we hold (GDPR portability)' })
  async exportData(@CurrentUser('id') userId: string, @Res() res: Response): Promise<void> {
    const data = await this.users.exportData(userId);
    // Indented on purpose: a backup is a file a person may well open and read,
    // and 2-space JSON costs a few percent on a file this size.
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="eco-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.setHeader('Content-Length', body.length);
    // Every figure this user has: never let a shared proxy hold a copy.
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(body);
  }

  @Delete('me')
  @Audit('DELETE', 'User')
  @ApiOperation({ summary: 'Schedule account deletion after a 30-day grace period' })
  async deleteAccount(@CurrentUser('id') userId: string) {
    return this.users.requestDeletion(userId);
  }
}
