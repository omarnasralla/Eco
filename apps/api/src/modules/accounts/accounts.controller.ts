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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  accountSchema,
  reconcileAccountSchema,
  updateAccountSchema,
  type AccountInput,
  type ReconcileAccountInput,
  type UpdateAccountInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AccountsService } from './accounts.service';

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List accounts' })
  async findAll(@CurrentUser('id') userId: string) {
    return this.accounts.findAll(userId);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Every balance converted into the base currency' })
  async summary(@CurrentUser() user: { id: string; currency: string }) {
    return this.accounts.summary(user.id, user.currency);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one account' })
  async findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.accounts.findOne(userId, id);
  }

  @Post()
  @Audit('CREATE', 'FinancialAccount')
  @ApiOperation({ summary: 'Add an account' })
  async create(
    @CurrentUser('id') userId: string,
    @Body(zodBody(accountSchema)) dto: AccountInput,
  ) {
    return this.accounts.create(userId, dto);
  }

  @Patch(':id')
  @Audit('UPDATE', 'FinancialAccount')
  @ApiOperation({ summary: 'Rename an account or set its balance' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateAccountSchema)) dto: UpdateAccountInput,
  ) {
    return this.accounts.update(userId, id, dto);
  }

  @Post(':id/reconcile')
  @Audit('UPDATE', 'FinancialAccount')
  @ApiOperation({
    summary: 'Read the balance from a hand count; the difference is shown, not booked',
  })
  async reconcile(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(reconcileAccountSchema)) dto: ReconcileAccountInput,
  ) {
    return this.accounts.reconcile(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'FinancialAccount')
  @ApiOperation({ summary: 'Remove an account' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.accounts.remove(userId, id);
  }
}
