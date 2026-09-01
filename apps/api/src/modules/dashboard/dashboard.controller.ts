import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Headline widgets: income, expenses, debt, net worth, bills' })
  async summary(
    @CurrentUser() user: { id: string; currency: string },
    @Query('month') month?: string,
  ) {
    return this.dashboard.summary(user.id, user.currency, month);
  }

  @Get('trend')
  @ApiOperation({ summary: 'Monthly income vs expenses' })
  async trend(
    @CurrentUser() user: { id: string; currency: string },
    @Query('months') months?: string,
  ) {
    return this.dashboard.trend(user.id, user.currency, months ? Number(months) : 12);
  }

  @Get('category-breakdown')
  @ApiOperation({ summary: 'Spend by category with month-over-month change' })
  async categoryBreakdown(
    @CurrentUser('id') userId: string,
    @Query('month') month?: string,
  ) {
    return this.dashboard.categoryBreakdown(
      userId,
      month ?? new Date().toISOString().slice(0, 7),
    );
  }

  @Get('upcoming-bills')
  @ApiOperation({ summary: 'Debts and recurring charges falling due soon' })
  async upcomingBills(@CurrentUser('id') userId: string, @Query('days') days?: string) {
    return this.dashboard.upcomingBills(userId, days ? Number(days) : 14);
  }

  @Get('net-worth-history')
  @ApiOperation({ summary: 'Savings, debt and net worth over time' })
  async netWorthHistory(@CurrentUser('id') userId: string, @Query('months') months?: string) {
    return this.dashboard.netWorthHistory(userId, months ? Number(months) : 12);
  }
}
