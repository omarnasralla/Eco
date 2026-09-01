import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { reportRequestSchema, type ReportRequest } from '@eco/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Audit } from '../../common/decorators/audit.decorator';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({ summary: 'List previously generated reports' })
  async list(@CurrentUser('id') userId: string) {
    return this.reports.list(userId);
  }

  @Post('generate')
  @Throttle({ export: { limit: 20, ttl: 3_600_000 } })
  @Audit('EXPORT', 'Report')
  @ApiOperation({ summary: 'Generate and download a report as PDF, XLSX or CSV' })
  async generate(
    @CurrentUser() user: { id: string; currency: string },
    @Body(zodBody(reportRequestSchema)) dto: ReportRequest,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.reports.generate(user.id, user.currency, dto);

    res.setHeader('Content-Type', report.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.setHeader('Content-Length', report.buffer.length);
    // A financial report must never sit in a shared proxy cache.
    res.setHeader('Cache-Control', 'no-store, private');
    res.send(report.buffer);
  }
}
