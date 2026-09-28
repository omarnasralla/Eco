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
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ingestExpenseSchema,
  ingestSmsSchema,
  ingestTokenSchema,
  type IngestExpenseInput,
  type IngestSmsInput,
  type IngestTokenInput,
} from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { IngestTokenGuard } from './ingest.guard';
import { IngestService } from './ingest.service';

@ApiTags('ingest')
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  @Get('tokens')
  @ApiOperation({ summary: 'List capture tokens' })
  async listTokens(@CurrentUser('id') userId: string) {
    return this.ingest.listTokens(userId);
  }

  @Post('tokens')
  @Audit('CREATE', 'IngestToken')
  @ApiOperation({ summary: 'Mint a capture token; the secret is returned once' })
  async createToken(
    @CurrentUser('id') userId: string,
    @Body(zodBody(ingestTokenSchema)) dto: IngestTokenInput,
  ) {
    return this.ingest.createToken(userId, dto.label);
  }

  /**
   * Forward a bank SMS alert.
   *
   * Covers what the Wallet tap automation cannot: online and in-app purchases,
   * refunds, and money sent to or received from a person. Same token, same
   * rate limit, and an unrecognised message is refused rather than guessed at.
   */
  @Public()
  @UseGuards(IngestTokenGuard)
  @Throttle({ default: { limit: 120, ttl: 3_600_000 } })
  @Post('sms')
  @Audit('CREATE', 'Expense')
  @ApiOperation({ summary: 'Record a bank SMS alert (capture token auth)' })
  async captureSms(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(ingestSmsSchema)) dto: IngestSmsInput,
  ) {
    return this.ingest.captureSms(user.id, user.currency, dto.text);
  }

  @Delete('tokens/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Audit('DELETE', 'IngestToken')
  @ApiOperation({ summary: 'Revoke a capture token' })
  async revokeToken(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.ingest.revokeToken(userId, id);
  }

  /**
   * The one route a phone may call.
   *
   * `@Public` only turns off the JWT guard — `IngestTokenGuard` then demands a
   * capture token, so this is authenticated, just not by a session. The guard
   * sets `req.user`, which is what makes `@CurrentUser` and the audit trail
   * work here exactly as they do everywhere else.
   */
  @Public()
  @UseGuards(IngestTokenGuard)
  // A tap takes a second; nobody taps 120 times an hour. High enough never to
  // bother a real person, low enough that a leaked token cannot fill a ledger.
  @Throttle({ default: { limit: 120, ttl: 3_600_000 } })
  @Post('expenses')
  @Audit('CREATE', 'Expense')
  @ApiOperation({ summary: 'Record a card tap as an expense (capture token auth)' })
  async capture(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(ingestExpenseSchema)) dto: IngestExpenseInput,
  ) {
    return this.ingest.capture(user.id, user.currency, dto);
  }
}
