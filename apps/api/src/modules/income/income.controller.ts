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
import { z } from 'zod';
import {
  incomeSourceSchema,
  isoDate,
  minorAmount,
  updateIncomeSourceSchema,
  type IncomeSourceInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { IncomeService } from './income.service';

const receiptSchema = z.object({
  amountMinor: minorAmount,
  date: isoDate,
  notes: z.string().trim().max(500).nullish(),
});

@ApiTags('income')
@Controller('income')
export class IncomeController {
  constructor(private readonly income: IncomeService) {}

  @Get()
  @ApiOperation({ summary: 'List income sources' })
  async findAll(
    @CurrentUser('id') userId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.income.findAll(userId, includeInactive === 'true');
  }

  @Get('summary')
  @ApiOperation({ summary: 'Total monthly income in the base currency' })
  async summary(@CurrentUser() user: { id: string; currency: string }) {
    return {
      monthlyTotalMinor: await this.income.monthlyTotal(user.id, user.currency),
      currency: user.currency,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one income source' })
  async findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.income.findOne(userId, id);
  }

  @Post()
  @Audit('CREATE', 'IncomeSource')
  @ApiOperation({ summary: 'Add an income source' })
  async create(
    @CurrentUser('id') userId: string,
    @Body(zodBody(incomeSourceSchema)) dto: IncomeSourceInput,
  ) {
    return this.income.create(userId, dto);
  }

  @Post(':id/receipts')
  @Audit('CREATE', 'IncomeReceipt')
  @ApiOperation({ summary: 'Record an actual payment received' })
  async recordReceipt(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(receiptSchema)) dto: { amountMinor: number; date: string; notes?: string | null },
  ) {
    return this.income.recordReceipt(user.id, id, dto, user.currency);
  }

  @Patch(':id')
  @Audit('UPDATE', 'IncomeSource')
  @ApiOperation({ summary: 'Update an income source' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateIncomeSourceSchema)) dto: Partial<IncomeSourceInput>,
  ) {
    return this.income.update(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'IncomeSource')
  @ApiOperation({ summary: 'Remove an income source' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.income.remove(userId, id);
  }
}
