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
import { taskSchema, updateTaskSchema, type TaskInput, type UpdateTaskInput } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { TasksService } from './tasks.service';

type Me = { id: string; timezone: string };

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @ApiOperation({ summary: 'Open tasks in order of attention, plus the last week of done ones' })
  async list(@CurrentUser() user: Me) {
    return this.tasks.list(user.id, user.timezone);
  }

  @Post()
  @ApiOperation({ summary: 'Add a task' })
  async create(@CurrentUser() user: Me, @Body(zodBody(taskSchema)) dto: TaskInput) {
    return this.tasks.create(user.id, user.timezone, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a task or change its date' })
  async update(
    @CurrentUser() user: Me,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateTaskSchema)) dto: UpdateTaskInput,
  ) {
    return this.tasks.update(user.id, id, user.timezone, dto);
  }

  @Post(':id/done')
  @ApiOperation({ summary: 'Mark done' })
  async done(@CurrentUser() user: Me, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.setDone(user.id, id, user.timezone, true);
  }

  @Post(':id/undo')
  @ApiOperation({ summary: 'Mark not done' })
  async undo(@CurrentUser() user: Me, @Param('id', ParseUUIDPipe) id: string) {
    return this.tasks.setDone(user.id, id, user.timezone, false);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a task' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.tasks.remove(userId, id);
  }
}
