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
  goalContributionSchema,
  savingsGoalSchema,
  updateSavingsGoalSchema,
  type GoalContributionInput,
  type SavingsGoalInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { GoalsService } from './goals.service';

@ApiTags('goals')
@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  @ApiOperation({ summary: 'List savings goals with progress projections' })
  async findAll(@CurrentUser('id') userId: string, @Query('includeArchived') archived?: string) {
    return this.goals.findAll(userId, archived === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one savings goal' })
  async findOne(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.findOne(userId, id);
  }

  @Get(':id/contributions')
  @ApiOperation({ summary: 'Contribution history for a goal' })
  async contributions(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.goals.listContributions(userId, id);
  }

  @Post()
  @Audit('CREATE', 'SavingsGoal')
  @ApiOperation({ summary: 'Create a savings goal' })
  async create(
    @CurrentUser('id') userId: string,
    @Body(zodBody(savingsGoalSchema)) dto: SavingsGoalInput,
  ) {
    return this.goals.create(userId, dto);
  }

  @Post(':id/contributions')
  @Audit('CREATE', 'GoalContribution')
  @ApiOperation({ summary: 'Add to (or withdraw from) a goal' })
  async contribute(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(goalContributionSchema)) dto: GoalContributionInput,
  ) {
    return this.goals.contribute(userId, id, dto);
  }

  @Patch(':id')
  @Audit('UPDATE', 'SavingsGoal')
  @ApiOperation({ summary: 'Update a savings goal' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(zodBody(updateSavingsGoalSchema)) dto: Partial<SavingsGoalInput>,
  ) {
    return this.goals.update(userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'SavingsGoal')
  @ApiOperation({ summary: 'Abandon a savings goal' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.goals.remove(userId, id);
  }
}
