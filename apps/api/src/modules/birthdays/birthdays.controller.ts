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
  birthdaySchema,
  updateBirthdaySchema,
  type BirthdayInput,
  type UpdateBirthdayInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { BirthdaysService } from './birthdays.service';

type Me = { id: string; timezone: string };

@ApiTags('birthdays')
@Controller('birthdays')
export class BirthdaysController {
  constructor(private readonly birthdays: BirthdaysService) {}

  @Get()
  @ApiOperation({ summary: 'Every birthday, soonest first' })
  async list(@CurrentUser() user: Me) {
    return this.birthdays.list(user.id, user.timezone);
  }

  @Post()
  @ApiOperation({ summary: 'Remember a birthday' })
  async create(@CurrentUser() user: Me, @Body(zodBody(birthdaySchema)) dto: BirthdayInput) {
    return this.birthdays.create(user.id, user.timezone, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a birthday' })
  async update(
    @CurrentUser() user: Me,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateBirthdaySchema)) dto: UpdateBirthdayInput,
  ) {
    return this.birthdays.update(user.id, id, user.timezone, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Forget a birthday' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.birthdays.remove(userId, id);
  }
}
