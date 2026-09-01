import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('me')
  @ApiOperation({ summary: 'Your own account activity log' })
  async findForUser(@CurrentUser('id') userId: string, @Query('limit') limit?: string) {
    return this.audit.findForUser(userId, limit ? Number(limit) : 100);
  }
}
