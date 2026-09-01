import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { formatMoney } from '@eco/shared';
import type { ReportRequest } from '@eco/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { toNumber } from '../../common/utils/money';
import { fromIsoDate, requireIsoDate, todayIso } from '../../common/utils/dates';

export interface GeneratedReport {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/**
 * Report generation.
 *
 * Reports are produced synchronously and streamed straight back — a personal
 * finance report covers at most a year of one user's data, which renders in
 * well under a second. Nothing is written to disk or object storage, so there
 * is no bucket of un-expired financial documents to secure. The `Report` table
 * exists to record that an export happened, which the audit log requires.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly dashboard: DashboardService,
  ) {}

  async generate(
    userId: string,
    userCurrency: string,
    request: ReportRequest,
  ): Promise<GeneratedReport> {
    const { from, to } = this.resolvePeriod(request);
    const data = await this.collect(userId, userCurrency, from, to);

    await this.prisma.report.create({
      data: {
        userId,
        period: request.period,
        periodStart: fromIsoDate(from),
        periodEnd: fromIsoDate(to),
        format: request.format,
        status: 'READY',
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 3_600 * 1000),
      },
    });

    const stem = `eco-${request.period.toLowerCase()}-${from}-to-${to}`;

    switch (request.format) {
      case 'CSV':
        return {
          buffer: this.buildCsv(data),
          filename: `${stem}.csv`,
          contentType: 'text/csv; charset=utf-8',
        };
      case 'XLSX':
        return {
          buffer: await this.buildXlsx(data),
          filename: `${stem}.xlsx`,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
      case 'PDF':
      default:
        return {
          buffer: await this.buildPdf(data),
          filename: `${stem}.pdf`,
          contentType: 'application/pdf',
        };
    }
  }

  async list(userId: string) {
    const reports = await this.prisma.report.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return reports.map((r) => ({
      id: r.id,
      period: r.period,
      from: requireIsoDate(r.periodStart),
      to: requireIsoDate(r.periodEnd),
      format: r.format,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // ── Data collection ─────────────────────────────────────────────────────

  private async collect(userId: string, currency: string, from: string, to: string) {
    const [user, expenses, income, debts, goals, breakdown] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true, email: true, locale: true },
      }),
      this.prisma.expense.findMany({
        where: {
          userId,
          deletedAt: null,
          date: { gte: fromIsoDate(from), lte: fromIsoDate(to) },
        },
        include: { category: { select: { name: true, color: true } } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.incomeReceipt.findMany({
        where: { userId, date: { gte: fromIsoDate(from), lte: fromIsoDate(to) } },
        include: { incomeSource: { select: { name: true, type: true } } },
        orderBy: { date: 'asc' },
      }),
      this.prisma.debt.findMany({ where: { userId, deletedAt: null } }),
      this.prisma.savingsGoal.findMany({ where: { userId, deletedAt: null } }),
      this.dashboard.categoryBreakdown(userId, from.slice(0, 7)),
    ]);

    const totalExpensesMinor = expenses.reduce((s, e) => s + toNumber(e.baseAmountMinor), 0);
    const totalIncomeMinor = income.reduce((s, r) => s + toNumber(r.baseAmountMinor), 0);

    return {
      user,
      currency,
      from,
      to,
      expenses: expenses.map((e) => ({
        date: requireIsoDate(e.date),
        category: e.category.name,
        merchant: e.merchant ?? '',
        amountMinor: toNumber(e.amountMinor),
        baseAmountMinor: toNumber(e.baseAmountMinor),
        currency: e.currency,
        notes: e.notes ?? '',
        tags: e.tags.join(', '),
      })),
      income: income.map((r) => ({
        date: requireIsoDate(r.date),
        source: r.incomeSource.name,
        type: r.incomeSource.type,
        amountMinor: toNumber(r.baseAmountMinor),
      })),
      debts: debts.map((d) => ({
        name: d.name,
        type: d.type,
        balanceMinor: toNumber(d.currentBalanceMinor),
        apr: Number(d.interestRateApr),
        minimumMinor: toNumber(d.minimumPaymentMinor),
      })),
      goals: goals.map((g) => ({
        name: g.name,
        targetMinor: toNumber(g.targetAmountMinor),
        currentMinor: toNumber(g.currentAmountMinor),
        progressPct:
          toNumber(g.targetAmountMinor) > 0
            ? Math.round((toNumber(g.currentAmountMinor) / toNumber(g.targetAmountMinor)) * 100)
            : 0,
      })),
      breakdown,
      totals: {
        expensesMinor: totalExpensesMinor,
        incomeMinor: totalIncomeMinor,
        netMinor: totalIncomeMinor - totalExpensesMinor,
        transactionCount: expenses.length,
      },
    };
  }

  // ── Formats ─────────────────────────────────────────────────────────────

  private buildCsv(data: Awaited<ReturnType<ReportsService['collect']>>): Buffer {
    const escape = (value: string | number): string => {
      const str = String(value);
      // RFC 4180: quote anything containing a delimiter, quote or newline, and
      // double any embedded quotes.
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const lines: string[] = [];
    lines.push(`Eco expense export,${data.from} to ${data.to},${data.currency}`);
    lines.push('');
    lines.push(['Date', 'Category', 'Merchant', 'Amount', 'Currency', 'Amount (base)', 'Tags', 'Notes'].join(','));

    for (const e of data.expenses) {
      lines.push(
        [
          e.date,
          escape(e.category),
          escape(e.merchant),
          (e.amountMinor / 100).toFixed(2),
          e.currency,
          (e.baseAmountMinor / 100).toFixed(2),
          escape(e.tags),
          escape(e.notes),
        ].join(','),
      );
    }

    lines.push('');
    lines.push(`Total expenses,${(data.totals.expensesMinor / 100).toFixed(2)}`);
    lines.push(`Total income,${(data.totals.incomeMinor / 100).toFixed(2)}`);
    lines.push(`Net,${(data.totals.netMinor / 100).toFixed(2)}`);

    // A BOM so Excel opens UTF-8 correctly instead of mangling every symbol.
    return Buffer.from(`﻿${lines.join('\n')}`, 'utf8');
  }

  private async buildXlsx(
    data: Awaited<ReturnType<ReportsService['collect']>>,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Eco';
    workbook.created = new Date();

    const money = '#,##0.00';

    const summary = workbook.addWorksheet('Summary');
    summary.columns = [
      { header: 'Metric', key: 'metric', width: 32 },
      { header: 'Value', key: 'value', width: 20, style: { numFmt: money } },
    ];
    summary.addRows([
      { metric: 'Period', value: `${data.from} to ${data.to}` },
      { metric: 'Currency', value: data.currency },
      { metric: 'Total income', value: data.totals.incomeMinor / 100 },
      { metric: 'Total expenses', value: data.totals.expensesMinor / 100 },
      { metric: 'Net', value: data.totals.netMinor / 100 },
      { metric: 'Transactions', value: data.totals.transactionCount },
    ]);
    summary.getRow(1).font = { bold: true };

    const expenses = workbook.addWorksheet('Expenses');
    expenses.columns = [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Merchant', key: 'merchant', width: 28 },
      { header: 'Amount', key: 'amount', width: 14, style: { numFmt: money } },
      { header: 'Currency', key: 'currency', width: 10 },
      { header: 'Tags', key: 'tags', width: 20 },
      { header: 'Notes', key: 'notes', width: 40 },
    ];
    for (const e of data.expenses) {
      expenses.addRow({
        date: e.date,
        category: e.category,
        merchant: e.merchant,
        amount: e.amountMinor / 100,
        currency: e.currency,
        tags: e.tags,
        notes: e.notes,
      });
    }
    expenses.getRow(1).font = { bold: true };
    expenses.autoFilter = { from: 'A1', to: 'G1' };

    const byCategory = workbook.addWorksheet('By category');
    byCategory.columns = [
      { header: 'Category', key: 'category', width: 24 },
      { header: 'Amount', key: 'amount', width: 14, style: { numFmt: money } },
      { header: 'Share %', key: 'share', width: 12 },
      { header: 'Transactions', key: 'count', width: 14 },
    ];
    for (const c of data.breakdown) {
      byCategory.addRow({
        category: c.categoryName,
        amount: c.amountMinor / 100,
        share: c.sharePct,
        count: c.transactionCount,
      });
    }
    byCategory.getRow(1).font = { bold: true };

    if (data.debts.length > 0) {
      const debts = workbook.addWorksheet('Debts');
      debts.columns = [
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Type', key: 'type', width: 18 },
        { header: 'Balance', key: 'balance', width: 16, style: { numFmt: money } },
        { header: 'APR %', key: 'apr', width: 10 },
        { header: 'Minimum', key: 'minimum', width: 14, style: { numFmt: money } },
      ];
      for (const d of data.debts) {
        debts.addRow({
          name: d.name,
          type: d.type,
          balance: d.balanceMinor / 100,
          apr: d.apr,
          minimum: d.minimumMinor / 100,
        });
      }
      debts.getRow(1).font = { bold: true };
    }

    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  private buildPdf(data: Awaited<ReturnType<ReportsService['collect']>>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fmt = (minor: number) => formatMoney(minor, data.currency, { locale: data.user.locale });

      doc.fontSize(24).fillColor('#16a34a').text('Eco', { continued: false });
      doc.moveDown(0.2);
      doc.fontSize(16).fillColor('#0f172a').text('Financial report');
      doc.fontSize(10).fillColor('#64748b').text(`${data.from} to ${data.to} · ${data.user.name}`);
      doc.moveDown(1.5);

      doc.fontSize(13).fillColor('#0f172a').text('Summary');
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#334155');
      const rows: Array<[string, string]> = [
        ['Total income', fmt(data.totals.incomeMinor)],
        ['Total expenses', fmt(data.totals.expensesMinor)],
        ['Net', fmt(data.totals.netMinor)],
        ['Transactions', String(data.totals.transactionCount)],
      ];
      for (const [label, value] of rows) {
        doc.text(label, { continued: true }).text(value, { align: 'right' });
      }

      doc.moveDown(1.5);
      doc.fontSize(13).fillColor('#0f172a').text('Spending by category');
      doc.moveDown(0.5);
      doc.fontSize(10).fillColor('#334155');

      for (const c of data.breakdown.slice(0, 15)) {
        doc
          .text(`${c.categoryName} (${c.sharePct}%)`, { continued: true })
          .text(fmt(c.amountMinor), { align: 'right' });
      }

      if (data.debts.length > 0) {
        doc.moveDown(1.5);
        doc.fontSize(13).fillColor('#0f172a').text('Debts');
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#334155');
        for (const d of data.debts) {
          doc
            .text(`${d.name} — ${d.apr}% APR`, { continued: true })
            .text(fmt(d.balanceMinor), { align: 'right' });
        }
      }

      if (data.goals.length > 0) {
        doc.moveDown(1.5);
        doc.fontSize(13).fillColor('#0f172a').text('Savings goals');
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#334155');
        for (const g of data.goals) {
          doc
            .text(`${g.name} (${g.progressPct}%)`, { continued: true })
            .text(`${fmt(g.currentMinor)} of ${fmt(g.targetMinor)}`, { align: 'right' });
        }
      }

      doc.moveDown(2);
      doc
        .fontSize(8)
        .fillColor('#94a3b8')
        .text(
          `Generated by Eco on ${new Date().toISOString().slice(0, 10)}. Figures are converted to ${data.currency} at the rate on each transaction date.`,
        );

      doc.end();
    });
  }

  private resolvePeriod(request: ReportRequest): { from: string; to: string } {
    if (request.period === 'CUSTOM' && request.from && request.to) {
      return { from: request.from, to: request.to };
    }

    const today = new Date();
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();

    switch (request.period) {
      case 'YEARLY':
        return { from: `${year}-01-01`, to: `${year}-12-31` };
      case 'QUARTERLY': {
        const quarterStart = Math.floor(month / 3) * 3;
        const start = new Date(Date.UTC(year, quarterStart, 1));
        const end = new Date(Date.UTC(year, quarterStart + 3, 0));
        return {
          from: start.toISOString().slice(0, 10),
          to: end.toISOString().slice(0, 10),
        };
      }
      case 'MONTHLY':
      default: {
        const start = new Date(Date.UTC(year, month, 1));
        const end = new Date(Date.UTC(year, month + 1, 0));
        return {
          from: start.toISOString().slice(0, 10),
          to: end.toISOString().slice(0, 10),
        };
      }
    }
  }

  /** Drops report records past their retention window. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async pruneExpired(): Promise<void> {
    if (!(await this.redis.acquireLock('report-prune', 600))) return;
    try {
      const { count } = await this.prisma.report.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (count > 0) this.logger.log(`Pruned ${count} expired report records`);
    } finally {
      await this.redis.releaseLock('report-prune');
    }
  }
}
