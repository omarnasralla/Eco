import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  debtPaymentSchema,
  debtSchema,
  payoffPlanSchema,
  updateDebtSchema,
  type DebtInput,
  type DebtPaymentInput,
  type PayoffPlanInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { DebtsService } from './debts.service';

@ApiTags('debts')
@Controller('debts')
export class DebtsController {
  constructor(private readonly debts: DebtsService) {}

  @Get()
  @ApiOperation({ summary: 'List debts with payoff projections' })
  async findAll(@CurrentUser('id') userId: string, @Query('includeClosed') includeClosed?: string) {
    return this.debts.findAll(userId, includeClosed === 'true');
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Payments due in the next N days' })
  async upcoming(@CurrentUser('id') userId: string, @Query('days') days?: string) {
    return this.debts.upcomingDue(userId, days ? Number(days) : 14);
  }

  @Get('strategies/compare')
  @ApiOperation({ summary: 'Snowball vs avalanche vs minimum-only' })
  async compare(
    @CurrentUser('id') userId: string,
    @Query('monthlyBudgetMinor') monthlyBudgetMinor: string,
  ) {
    return this.debts.compare(userId, Number(monthlyBudgetMinor));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one debt' })
  async findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.debts.findOne(userId, id);
  }

  @Get(':id/payments')
  @ApiOperation({ summary: 'Payment history for a debt' })
  async payments(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.debts.listPayments(userId, id);
  }

  @Post()
  @Audit('CREATE', 'Debt')
  @ApiOperation({ summary: 'Add a debt' })
  async create(@CurrentUser('id') userId: string, @Body(zodBody(debtSchema)) dto: DebtInput) {
    return this.debts.create(userId, dto);
  }

  @Post(':id/payments')
  @Audit('CREATE', 'DebtPayment')
  @ApiOperation({ summary: 'Record a payment against a debt' })
  async recordPayment(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(debtPaymentSchema)) dto: DebtPaymentInput,
  ) {
    return this.debts.recordPayment(userId, id, dto);
  }

  @Post('payoff-plan')
  @Audit('CREATE', 'PayoffPlan')
  @ApiOperation({ summary: 'Build and save a payoff plan with a full schedule' })
  async payoffPlan(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(payoffPlanSchema)) dto: PayoffPlanInput,
  ) {
    return this.debts.buildPayoffPlan(user.id, dto, user.currency);
  }

  @Patch(':id')
  @Audit('UPDATE', 'Debt')
  @ApiOperation({ summary: 'Update a debt' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateDebtSchema)) dto: Partial<DebtInput> & { isClosed?: boolean },
  ) {
    return this.debts.update(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'Debt')
  @ApiOperation({ summary: 'Remove a debt' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.debts.remove(userId, id);
  }
}
