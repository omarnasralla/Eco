'use client';

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Download, FileSpreadsheet, FileText, Loader2, Table } from 'lucide-react';
import type { ExportFormat, ReportPeriod } from '@eco/shared';
import { apiFetch } from '@/lib/api-client';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const FORMATS: Array<{ value: ExportFormat; label: string; hint: string; icon: typeof FileText }> = [
  { value: 'PDF', label: 'PDF', hint: 'A readable summary to keep or share', icon: FileText },
  { value: 'XLSX', label: 'Excel', hint: 'Multi-sheet workbook with formulas ready', icon: FileSpreadsheet },
  { value: 'CSV', label: 'CSV', hint: 'Raw rows for your own analysis', icon: Table },
];

export default function ReportsPage() {
  const [period, setPeriod] = useState<ReportPeriod>('MONTHLY');
  const [error, setError] = useState<string | null>(null);

  const download = useMutation({
    mutationFn: async (format: ExportFormat) => {
      const blob = await apiFetch<Blob>('/reports/generate', {
        method: 'POST',
        body: { period, format, includeCharts: true },
      });

      // The API streams the file back rather than storing it, so the download
      // is driven from an object URL here and revoked immediately after.
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `eco-${period.toLowerCase()}-report.${format.toLowerCase()}`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    onError: () => setError('Could not generate that report. Please try again.'),
  });

  return (
    <>
      <PageHeader
        title="Reports"
        description="Export your figures for your accountant, your records, or your own analysis."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Generate a report</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-5 max-w-xs space-y-2">
            <label htmlFor="period" className="text-sm font-medium">
              Period
            </label>
            <Select value={period} onValueChange={(value) => setPeriod(value as ReportPeriod)}>
              <SelectTrigger id="period">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MONTHLY">This month</SelectItem>
                <SelectItem value="QUARTERLY">This quarter</SelectItem>
                <SelectItem value="YEARLY">This year</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {FORMATS.map((format) => {
              const Icon = format.icon;
              const busy = download.isPending && download.variables === format.value;
              return (
                <button
                  key={format.value}
                  type="button"
                  onClick={() => {
                    setError(null);
                    download.mutate(format.value);
                  }}
                  disabled={download.isPending}
                  className="flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors hover:bg-accent disabled:opacity-60"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Icon className="size-4 text-primary" aria-hidden />
                    )}
                    {format.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{format.hint}</span>
                  <span className="mt-1 flex items-center gap-1 text-xs text-primary">
                    <Download className="size-3" aria-hidden />
                    Download
                  </span>
                </button>
              );
            })}
          </div>

          {error ? (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <p className="mt-5 text-xs text-muted-foreground">
            Reports are generated on demand and streamed straight to you — nothing is stored on a
            server afterwards.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
