import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BalanceFlowDto } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BalanceService } from './balance.service';

@ApiTags('balance')
@Controller('balance')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

  @Get('flow')
  @ApiOperation({ summary: "Each card's stated balances, and the fees between them" })
  async flow(@CurrentUser('id') userId: string): Promise<BalanceFlowDto[]> {
    return this.balance.flow(userId);
  }
}
