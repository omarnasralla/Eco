import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { aiChatSchema, type AiChatInput } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { AiService } from './ai.service';

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Post('chat')
  // Inference is the most expensive operation in the system, so it gets its
  // own tighter budget than the general API limit.
  @Throttle({ ai: { limit: 20, ttl: 60_000 } })
  @Audit('AI_QUERY', 'AiConversation')
  @ApiOperation({ summary: 'Ask Eco AI a question about your finances' })
  async chat(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(aiChatSchema)) dto: AiChatInput,
  ) {
    return this.ai.chat(user.id, user.currency, dto.message, dto.conversationId);
  }

  @Get('conversations')
  @ApiOperation({ summary: 'List chat conversations' })
  async conversations(@CurrentUser('id') userId: string) {
    return this.ai.listConversations(userId);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get one conversation with its messages' })
  async conversation(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ai.getConversation(userId, id);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a conversation' })
  async deleteConversation(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.ai.deleteConversation(userId, id);
  }

  @Get('forecast')
  @ApiOperation({ summary: 'Cash-flow forecast with prediction intervals' })
  async forecast(
    @CurrentUser() user: { id: string; currency: string },
    @Query('horizonMonths') horizonMonths?: string,
  ) {
    return this.ai.forecast(user.id, user.currency, horizonMonths ? Number(horizonMonths) : 6);
  }

  @Get('patterns')
  @ApiOperation({ summary: 'Learned spending patterns and recurring charges' })
  async patterns(@CurrentUser() user: { id: string; currency: string }) {
    return this.ai.patterns(user.id, user.currency);
  }

  @Get('recommendations')
  @ApiOperation({ summary: 'Personalised, evidence-backed recommendations' })
  async recommendations(@CurrentUser() user: { id: string; currency: string }) {
    return this.ai.recommendations(user.id, user.currency);
  }

  @Post('recommendations/:id/dismiss')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Dismiss a recommendation' })
  async dismiss(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.ai.dismissRecommendation(userId, id);
  }

  @Get('health-score')
  @ApiOperation({ summary: 'Financial health score with its components' })
  async healthScore(@CurrentUser() user: { id: string; currency: string }) {
    return this.ai.healthScore(user.id, user.currency);
  }
}
