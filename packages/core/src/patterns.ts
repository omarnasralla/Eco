import { diffDays, monthOf, weekdayOf, type IsoDate, type IsoMonth } from './date-utils';
import { median } from './budget';
import type { Frequency } from '@eco/shared';

export interface TransactionLike {
  id: string;
  amountMinor: number;
  categoryId: string;
  date: IsoDate;
  merchant?: string | null;
}

export interface RecurringExpense {
  merchant: string;
  categoryId: string;
  averageAmountMinor: number;
  frequency: Frequency;
  /** Median gap between charges, in days. */
  medianIntervalDays: number;
  occurrences: number;
  firstSeen: IsoDate;
  lastSeen: IsoDate;
  /** Next charge predicted from lastSeen + the median interval. */
  nextExpectedDate: IsoDate;
  /** 0–1. Combines regularity of timing and stability of amount. */
  confidence: number;
}

/** Interval bands, in days, that map an observed cadence to a Frequency. */
const CADENCE_BANDS: Array<{ frequency: Frequency; min: number; max: number; centre: number }> = [
  { frequency: 'WEEKLY', min: 6, max: 8, centre: 7 },
  { frequency: 'BIWEEKLY', min: 12, max: 16, centre: 14 },
  { frequency: 'MONTHLY', min: 26, max: 35, centre: 30 },
  { frequency: 'QUARTERLY', min: 84, max: 98, centre: 91 },
  { frequency: 'YEARLY', min: 350, max: 380, centre: 365 },
];

function classifyCadence(intervalDays: number): { frequency: Frequency; fit: number } | null {
  const band = CADENCE_BANDS.find((b) => intervalDays >= b.min && intervalDays <= b.max);
  if (!band) return null;
  // How centred the observed interval is within its band, 0–1.
  const halfWidth = (band.max - band.min) / 2;
  const fit = 1 - Math.abs(intervalDays - band.centre) / Math.max(halfWidth, 1);
  return { frequency: band.frequency, fit: Math.max(0, Math.min(1, fit)) };
}

function normaliseMerchant(raw: string): string {
  // Card descriptors are noisy: "SQ *JOE'S COFFEE #4412  SEATTLE" → "joes coffee".
  // Order matters here. The `*` in "SQ *JOE'S COFFEE" separates the payment
  // processor from the real merchant, so it is consumed *with* the prefix —
  // stripping "*<word>" wholesale would delete the merchant name itself. And
  // apostrophes are deleted rather than spaced, so a descriptor that keeps them
  // ("JOE'S") normalises to the same key as one that drops them ("JOES").
  return raw
    .toLowerCase()
    .replace(/\b(sq|tst|pos|pmnt|purchase|payment|recurring)\b\s*\*?/g, ' ')
    .replace(/['\u2019]/g, '')
    .replace(/#\s*\w+/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds subscriptions and standing charges by looking for the same merchant
 * hitting the account at a steady cadence for a steady amount.
 *
 * Two signals must both hold: the gaps between charges cluster tightly (a
 * cadence), and the amounts barely move (a price).  Requiring both is what
 * keeps "coffee three times a week" out of the subscription list while still
 * catching an annual insurance premium from two data points.
 */
export function detectRecurringExpenses(
  transactions: TransactionLike[],
  options: { minOccurrences?: number; minConfidence?: number } = {},
): RecurringExpense[] {
  const { minOccurrences = 3, minConfidence = 0.6 } = options;

  const groups = new Map<string, TransactionLike[]>();
  for (const tx of transactions) {
    if (!tx.merchant) continue;
    const key = `${normaliseMerchant(tx.merchant)}::${tx.categoryId}`;
    if (key.startsWith('::')) continue;
    const bucket = groups.get(key);
    if (bucket) bucket.push(tx);
    else groups.set(key, [tx]);
  }

  const results: RecurringExpense[] = [];

  for (const [key, group] of groups) {
    if (group.length < Math.max(minOccurrences, 2)) continue;

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      intervals.push(diffDays(sorted[i - 1]!.date, sorted[i]!.date));
    }
    // Same-day duplicates are a split payment, not a cadence.
    const usable = intervals.filter((d) => d > 0);
    if (usable.length === 0) continue;

    const medianInterval = median(usable);
    const cadence = classifyCadence(medianInterval);
    if (!cadence) continue;

    // Timing regularity: how tightly the gaps cluster around their median.
    const intervalSpread =
      usable.reduce((s, d) => s + Math.abs(d - medianInterval), 0) / usable.length;
    const timingScore = Math.max(0, 1 - intervalSpread / Math.max(medianInterval * 0.5, 1));

    // Price stability: how tightly the amounts cluster around their median.
    const amounts = sorted.map((t) => t.amountMinor);
    const medianAmount = median(amounts);
    const amountSpread =
      medianAmount > 0
        ? amounts.reduce((s, a) => s + Math.abs(a - medianAmount), 0) /
          amounts.length /
          medianAmount
        : 1;
    const amountScore = Math.max(0, 1 - amountSpread / 0.25);

    // More sightings mean more evidence, saturating around six.
    const volumeScore = Math.min(sorted.length / 6, 1);

    const confidence =
      Math.round(
        (timingScore * 0.4 + amountScore * 0.35 + cadence.fit * 0.15 + volumeScore * 0.1) * 100,
      ) / 100;
    if (confidence < minConfidence) continue;

    const last = sorted[sorted.length - 1]!;
    results.push({
      merchant: key.split('::')[0] ?? '',
      categoryId: last.categoryId,
      averageAmountMinor: medianAmount,
      frequency: cadence.frequency,
      medianIntervalDays: medianInterval,
      occurrences: sorted.length,
      firstSeen: sorted[0]!.date,
      lastSeen: last.date,
      nextExpectedDate: addDaysIso(last.date, medianInterval),
      confidence,
    });
  }

  return results.sort((a, b) => b.averageAmountMinor - a.averageAmountMinor);
}

function addDaysIso(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Seasonality index per calendar month: 1.0 is an average month, 1.35 means a
 * user reliably spends 35% more then (December, or August for travel).  Needs
 * at least two years of data before it means anything.
 */
export function seasonalityIndex(
  monthlyTotals: Array<{ month: IsoMonth; amountMinor: number }>,
): Array<{ month: number; indexVsAverage: number; sampleSize: number }> {
  const byCalendarMonth = new Map<number, number[]>();
  for (const { month, amountMinor } of monthlyTotals) {
    const m = Number(month.slice(5, 7));
    const bucket = byCalendarMonth.get(m);
    if (bucket) bucket.push(amountMinor);
    else byCalendarMonth.set(m, [amountMinor]);
  }

  const overall =
    monthlyTotals.length > 0
      ? monthlyTotals.reduce((s, t) => s + t.amountMinor, 0) / monthlyTotals.length
      : 0;

  return Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const values = byCalendarMonth.get(m) ?? [];
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : overall;
    return {
      month: m,
      indexVsAverage: overall > 0 ? Math.round((avg / overall) * 1000) / 1000 : 1,
      sampleSize: values.length,
    };
  });
}

export function topMerchants(
  transactions: TransactionLike[],
  limit = 10,
): Array<{ merchant: string; amountMinor: number; count: number }> {
  const totals = new Map<string, { amountMinor: number; count: number }>();
  for (const tx of transactions) {
    if (!tx.merchant) continue;
    const key = normaliseMerchant(tx.merchant);
    if (!key) continue;
    const entry = totals.get(key) ?? { amountMinor: 0, count: 0 };
    entry.amountMinor += tx.amountMinor;
    entry.count += 1;
    totals.set(key, entry);
  }
  return [...totals.entries()]
    .map(([merchant, v]) => ({ merchant, ...v }))
    .sort((a, b) => b.amountMinor - a.amountMinor)
    .slice(0, limit);
}

/** Spend by day of week — surfaces the weekend-blowout pattern. */
export function weekdayDistribution(
  transactions: TransactionLike[],
): Array<{ weekday: number; amountMinor: number; count: number }> {
  const buckets = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    amountMinor: 0,
    count: 0,
  }));
  for (const tx of transactions) {
    const bucket = buckets[weekdayOf(tx.date)];
    if (!bucket) continue;
    bucket.amountMinor += tx.amountMinor;
    bucket.count += 1;
  }
  return buckets;
}

export function monthlyTotals(
  transactions: TransactionLike[],
): Array<{ month: IsoMonth; amountMinor: number }> {
  const totals = new Map<IsoMonth, number>();
  for (const tx of transactions) {
    const m = monthOf(tx.date);
    totals.set(m, (totals.get(m) ?? 0) + tx.amountMinor);
  }
  return [...totals.entries()]
    .map(([month, amountMinor]) => ({ month, amountMinor }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Flags a transaction as unusual for its category using a robust z-score
 * (median + MAD).  The mean and standard deviation would be dragged around by
 * the very outliers we are trying to find.
 */
export function detectAnomalies(
  transactions: TransactionLike[],
  threshold = 3.5,
): Array<{ transactionId: string; score: number; categoryId: string }> {
  const byCategory = new Map<string, TransactionLike[]>();
  for (const tx of transactions) {
    const bucket = byCategory.get(tx.categoryId);
    if (bucket) bucket.push(tx);
    else byCategory.set(tx.categoryId, [tx]);
  }

  const anomalies: Array<{ transactionId: string; score: number; categoryId: string }> = [];

  for (const [categoryId, group] of byCategory) {
    if (group.length < 8) continue; // Too little history to call anything odd.
    const amounts = group.map((t) => t.amountMinor);
    const med = median(amounts);
    const mad = median(amounts.map((a) => Math.abs(a - med)));
    if (mad === 0) continue;

    for (const tx of group) {
      // 0.6745 converts MAD to a standard-deviation-equivalent scale.
      const score = (0.6745 * (tx.amountMinor - med)) / mad;
      if (score > threshold) {
        anomalies.push({
          transactionId: tx.id,
          score: Math.round(score * 100) / 100,
          categoryId,
        });
      }
    }
  }

  return anomalies.sort((a, b) => b.score - a.score);
}
