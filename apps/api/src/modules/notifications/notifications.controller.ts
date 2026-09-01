import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  notificationPreferencesSchema,
  registerPushTokenSchema,
  type NotificationPreferences,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List notifications' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.findAll(userId, {
      unreadOnly: unreadOnly === 'true',
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (drives the badge)' })
  async unreadCount(@CurrentUser('id') userId: string) {
    return { count: await this.notifications.unreadCount(userId) };
  }

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences' })
  async preferences(@CurrentUser('id') userId: string) {
    return this.notifications.getPreferences(userId);
  }

  @Patch('preferences')
  @ApiOperation({ summary: 'Update notification preferences' })
  async updatePreferences(
    @CurrentUser('id') userId: string,
    @Body(zodBody(notificationPreferencesSchema.partial())) dto: Partial<NotificationPreferences>,
  ) {
    return this.notifications.updatePreferences(userId, dto);
  }

  @Post('push-tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register a device for push notifications' })
  async registerPushToken(
    @CurrentUser('id') userId: string,
    @Body(zodBody(registerPushTokenSchema))
    dto: { token: string; platform: 'IOS' | 'ANDROID' | 'WEB'; deviceName?: string },
  ) {
    await this.notifications.registerPushToken(userId, dto);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one notification as read' })
  async markRead(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(userId, id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark every notification as read' })
  async markAllRead(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }
}
