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
  markPurchasedSchema,
  plannedPurchaseSchema,
  updatePlannedPurchaseSchema,
  type MarkPurchasedInput,
  type PlannedPurchaseInput,
  type UpdatePlannedPurchaseInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { PlannedService } from './planned.service';

@ApiTags('planned')
@Controller('planned')
export class PlannedController {
  constructor(private readonly planned: PlannedService) {}

  @Get()
  @ApiOperation({ summary: "A month's planned purchases, with its totals" })
  async list(
    @CurrentUser() user: { id: string; currency: string },
    @Query('month') month?: string,
  ) {
    // Defaults to the month in progress, which is what someone opening the
    // page almost always means.
    return this.planned.list(user.id, user.currency, month ?? new Date().toISOString().slice(0, 10));
  }

  @Post()
  @Audit('CREATE', 'PlannedPurchase')
  @ApiOperation({ summary: 'Plan a purchase for a month' })
  async create(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(plannedPurchaseSchema)) dto: PlannedPurchaseInput,
  ) {
    return this.planned.create(user.id, user.currency, dto);
  }

  @Patch(':id')
  @Audit('UPDATE', 'PlannedPurchase')
  @ApiOperation({ summary: 'Change a planned purchase' })
  async update(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updatePlannedPurchaseSchema)) dto: UpdatePlannedPurchaseInput,
  ) {
    return this.planned.update(user.id, id, user.currency, dto);
  }

  @Post(':id/purchased')
  @Audit('UPDATE', 'PlannedPurchase')
  @ApiOperation({ summary: 'Mark bought; linking an expense applies the exclusion to it' })
  async markPurchased(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(markPurchasedSchema)) dto: MarkPurchasedInput,
  ) {
    return this.planned.markPurchased(user.id, id, user.currency, dto);
  }

  @Post(':id/cancel')
  @Audit('UPDATE', 'PlannedPurchase')
  @ApiOperation({ summary: 'Abandon a planned purchase, keeping it on the list' })
  async cancel(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.planned.cancel(user.id, id, user.currency);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'PlannedPurchase')
  @ApiOperation({ summary: 'Remove a planned purchase entirely' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.planned.remove(userId, id);
  }
}
