import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { budgetSchema, type BudgetInput } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { BudgetsService } from './budgets.service';
import { IncomeService } from '../income/income.service';

@ApiTags('budgets')
@Controller('budgets')
export class BudgetsController {
  constructor(
    private readonly budgets: BudgetsService,
    private readonly income: IncomeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the months that have a budget' })
  async list(@CurrentUser('id') userId: string, @Query('limit') limit?: string) {
    return this.budgets.list(userId, limit ? Number(limit) : 12);
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Propose limits from the last six months of spending' })
  async suggest(
    @CurrentUser() user: { id: string; currency: string },
    @Query('month') month: string,
  ) {
    const monthlyIncomeMinor = await this.income.monthlyTotal(user.id, user.currency);
    return this.budgets.suggest(user.id, month, monthlyIncomeMinor);
  }

  @Get(':month')
  @ApiOperation({ summary: 'Get a month’s budget with live spend and projections' })
  async findByMonth(
    @CurrentUser() user: { id: string; currency: string },
    @Param('month') month: string,
    // Affects the daily-allowance figures only; the budget itself is always
    // reported in its own currency.
    @Query('display') display?: string,
  ) {
    return this.budgets.findByMonth(user.id, month, user.currency, display);
  }

  @Put()
  @Audit('UPDATE', 'Budget')
  @ApiOperation({ summary: 'Create or replace a monthly budget' })
  async upsert(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(budgetSchema)) dto: BudgetInput,
  ) {
    return this.budgets.upsert(user.id, dto, user.currency);
  }

  @Delete(':month')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'Budget')
  @ApiOperation({ summary: 'Delete a monthly budget' })
  async remove(@CurrentUser('id') userId: string, @Param('month') month: string) {
    await this.budgets.remove(userId, month);
  }
}
