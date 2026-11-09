import { Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BriefingService } from './briefing.service';

@ApiTags('briefing')
@Controller('briefing')
export class BriefingController {
  constructor(private readonly briefing: BriefingService) {}

  @Get()
  @ApiOperation({ summary: "Today's briefing, as it would be pushed" })
  async preview(@CurrentUser('id') userId: string) {
    return this.briefing.build(userId);
  }

  @Post('send')
  @ApiOperation({ summary: 'Push a briefing now, outside the schedule' })
  async send(@CurrentUser('id') userId: string) {
    return this.briefing.sendNow(userId);
  }
}
