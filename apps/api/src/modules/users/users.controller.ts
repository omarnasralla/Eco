import { Body, Controller, Delete, Get, Patch, Post } from '@nestjs/common';
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
  @Audit('EXPORT', 'User')
  @ApiOperation({ summary: 'Download every record we hold (GDPR portability)' })
  async exportData(@CurrentUser('id') userId: string) {
    return this.users.exportData(userId);
  }

  @Delete('me')
  @Audit('DELETE', 'User')
  @ApiOperation({ summary: 'Schedule account deletion after a 30-day grace period' })
  async deleteAccount(@CurrentUser('id') userId: string) {
    return this.users.requestDeletion(userId);
  }
}
