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
  receivablePaymentSchema,
  receivableSchema,
  updateReceivableSchema,
  type ReceivableInput,
  type ReceivablePaymentInput,
  type UpdateReceivableInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ReceivablesService } from './receivables.service';

@ApiTags('receivables')
@Controller('receivables')
export class ReceivablesController {
  constructor(private readonly receivables: ReceivablesService) {}

  @Get()
  @ApiOperation({ summary: 'Money lent out, and what is still owed' })
  async findAll(@CurrentUser() user: { id: string; currency: string }) {
    return this.receivables.findAll(user.id, user.currency);
  }

  @Post()
  @Audit('CREATE', 'Receivable')
  @ApiOperation({ summary: 'Record money lent to someone' })
  async create(
    @CurrentUser('id') userId: string,
    @Body(zodBody(receivableSchema)) dto: ReceivableInput,
  ) {
    return this.receivables.create(userId, dto);
  }

  @Patch(':id')
  @Audit('UPDATE', 'Receivable')
  @ApiOperation({ summary: 'Edit a loan, or call it settled' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateReceivableSchema)) dto: UpdateReceivableInput,
  ) {
    return this.receivables.update(userId, id, dto);
  }

  @Post(':id/payments')
  @Audit('CREATE', 'ReceivablePayment')
  @ApiOperation({ summary: 'Record money coming back' })
  async addPayment(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(receivablePaymentSchema)) dto: ReceivablePaymentInput,
  ) {
    return this.receivables.addPayment(userId, id, dto);
  }

  @Delete(':id/payments/:paymentId')
  @Audit('DELETE', 'ReceivablePayment')
  @ApiOperation({ summary: 'Remove a repayment' })
  async removePayment(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.receivables.removePayment(userId, id, paymentId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'Receivable')
  @ApiOperation({ summary: 'Remove a loan' })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.receivables.remove(userId, id);
  }
}
