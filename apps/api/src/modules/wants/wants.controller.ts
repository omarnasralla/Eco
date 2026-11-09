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
  updateWantSchema,
  wantSchema,
  type UpdateWantInput,
  type WantInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { WantsService } from './wants.service';
import { WorkTimeService } from './work-time.service';

@ApiTags('wants')
@Controller('wants')
export class WantsController {
  constructor(
    private readonly wants: WantsService,
    private readonly workTime: WorkTimeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The cooling-off list, with what an hour of work earns' })
  async list(@CurrentUser() user: { id: string; currency: string }) {
    return this.wants.list(user.id, user.currency);
  }

  @Get('work-rate')
  @ApiOperation({ summary: 'What an hour of work earns, for restating prices as time' })
  async workRate(@CurrentUser() user: { id: string; currency: string }) {
    return this.workTime.rate(user.id, user.currency);
  }

  @Post()
  @Audit('CREATE', 'Want')
  @ApiOperation({ summary: 'Add something to wait on before buying' })
  async create(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(wantSchema)) dto: WantInput,
  ) {
    return this.wants.create(user.id, user.currency, dto);
  }

  @Patch(':id')
  @Audit('UPDATE', 'Want')
  @ApiOperation({ summary: 'Change a want; the wait itself cannot be shortened' })
  async update(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateWantSchema)) dto: UpdateWantInput,
  ) {
    return this.wants.update(user.id, id, user.currency, dto);
  }

  @Post(':id/buy')
  @Audit('UPDATE', 'Want')
  @ApiOperation({ summary: 'Decide to buy it — refused until the wait is over' })
  async buy(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.wants.buy(user.id, id, user.currency);
  }

  @Post(':id/skip')
  @Audit('UPDATE', 'Want')
  @ApiOperation({ summary: 'Let it go' })
  async skip(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.wants.skip(user.id, id, user.currency);
  }

  @Post(':id/reopen')
  @Audit('UPDATE', 'Want')
  @ApiOperation({ summary: 'Undo a decision' })
  async reopen(
    @CurrentUser() user: { id: string; currency: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.wants.reopen(user.id, id, user.currency);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'Want')
  @ApiOperation({ summary: 'Remove a want entirely' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.wants.remove(userId, id);
  }
}
