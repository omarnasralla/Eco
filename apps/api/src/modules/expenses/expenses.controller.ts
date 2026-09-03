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
  expenseQuerySchema,
  expenseSchema,
  updateExpenseSchema,
  type ExpenseInput,
  type ExpenseQuery,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ExpensesService } from './expenses.service';

const bulkSchema = z.object({ expenses: z.array(expenseSchema).min(1).max(500) });

@ApiTags('expenses')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @ApiOperation({ summary: 'List expenses with filters and a keyset cursor' })
  async findAll(
    @CurrentUser() user: { id: string; currency: string },
    @Query(zodBody(expenseQuerySchema)) query: ExpenseQuery,
  ) {
    return this.expenses.findAll(user.id, query, user.currency);
  }

  @Get('merchants')
  // Above @Get(':id'): Nest matches in declaration order, so a literal path
  // declared after a parameterised one is read as an id.
  @ApiOperation({ summary: 'Merchants used before, most-used first' })
  async merchants(
    @CurrentUser('id') userId: string,
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
  ) {
    return this.expenses.merchantSuggestions(userId, categoryId, search);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one expense' })
  async findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.expenses.findOne(userId, id);
  }

  @Post()
  @Audit('CREATE', 'Expense')
  @ApiOperation({ summary: 'Record an expense' })
  async create(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(expenseSchema)) dto: ExpenseInput,
  ) {
    return this.expenses.create(user.id, dto, user.currency);
  }

  @Post('bulk')
  @Audit('CREATE', 'Expense')
  @ApiOperation({ summary: 'Import many expenses at once (CSV or bank export)' })
  async createMany(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(bulkSchema)) dto: { expenses: ExpenseInput[] },
  ) {
    return this.expenses.createMany(user.id, dto.expenses, user.currency);
  }

  @Patch(':id')
  @Audit('UPDATE', 'Expense')
  @ApiOperation({ summary: 'Update an expense' })
  async update(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateExpenseSchema)) dto: Partial<ExpenseInput>,
  ) {
    return this.expenses.update(user.id, id, dto, user.currency);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'Expense')
  @ApiOperation({ summary: 'Delete an expense (soft)' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.expenses.remove(userId, id);
  }
}
