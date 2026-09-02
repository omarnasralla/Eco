/**
 * Money handling.
 *
 * Rule for the whole codebase: money is an **integer number of minor units**
 * (cents, fils, halalas) paired with an ISO-4217 currency code — end to end.
 * Postgres stores BIGINT, the API serialises JSON numbers, and only the
 * presentation layer ever formats to a locale string.  Floating point never
 * touches a balance, so no rounding error can accumulate across a ledger.
 *
 * Minor units stay inside IEEE-754's exact integer range (2^53) up to roughly
 * 90 trillion dollars, so `number` is safe on the wire; BIGINT at rest exists
 * to keep the database honest, not because we expect the values.
 */

export interface CurrencyMeta {
  code: string;
  name: string;
  symbol: string;
  /** Number of decimal places, per ISO 4217. */
  decimals: number;
}

export const CURRENCIES: readonly CurrencyMeta[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimals: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimals: 2 },
  { code: 'GBP', name: 'British Pound', symbol: '£', decimals: 2 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimals: 2 },
  { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', decimals: 2 },
  { code: 'EGP', name: 'Egyptian Pound', symbol: 'E£', decimals: 2 },
  // Zero decimals, matching ISO 4217 and CLDR: the piastre is long defunct,
  // and at ~89,500 to the dollar a ×100 scale would burn two orders of
  // magnitude of the safe-integer range for a subunit nobody quotes.
  { code: 'LBP', name: 'Lebanese Pound', symbol: 'ل.ل', decimals: 0 },
  { code: 'JOD', name: 'Jordanian Dinar', symbol: 'د.ا', decimals: 3 },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك', decimals: 3 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimals: 2 },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', decimals: 2 },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'CHF', decimals: 2 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', decimals: 0 },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', decimals: 2 },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺', decimals: 2 },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', decimals: 2 },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', decimals: 2 },
] as const;

const CURRENCY_INDEX = new Map(CURRENCIES.map((c) => [c.code, c]));

/** Custom currencies fall back to 2 decimals rather than throwing. */
export function currencyMeta(code: string): CurrencyMeta {
  return (
    CURRENCY_INDEX.get(code.toUpperCase()) ?? {
      code: code.toUpperCase(),
      name: code.toUpperCase(),
      symbol: code.toUpperCase(),
      decimals: 2,
    }
  );
}

export function minorUnitFactor(currency: string): number {
  return 10 ** currencyMeta(currency).decimals;
}

/** "12.34" | 12.34 → 1234 minor units. Rounds half away from zero. */
export function toMinorUnits(amount: number | string, currency: string): number {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot convert non-finite amount "${amount}" to minor units`);
  }
  const factor = minorUnitFactor(currency);
  const scaled = value * factor;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** 1234 minor units → 12.34 major units. For display and charts only. */
export function toMajorUnits(minor: number, currency: string): number {
  return minor / minorUnitFactor(currency);
}

export interface FormatMoneyOptions {
  locale?: string;
  /** Drop the fraction entirely — useful for axis ticks. */
  compact?: boolean;
  /** Render as "+$40.00" for positive values (cash-flow deltas). */
  signDisplay?: 'auto' | 'always' | 'never' | 'exceptZero';
}

/** Formats minor units for humans. Falls back gracefully for custom codes. */
export function formatMoney(
  minor: number,
  currency: string,
  options: FormatMoneyOptions = {},
): string {
  const { locale = 'en-US', compact = false, signDisplay = 'auto' } = options;
  const meta = currencyMeta(currency);
  const value = toMajorUnits(minor, currency);

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: meta.code,
      minimumFractionDigits: compact ? 0 : meta.decimals,
      maximumFractionDigits: compact ? 0 : meta.decimals,
      notation: compact ? 'compact' : 'standard',
      signDisplay,
    }).format(value);
  } catch {
    // Unknown/custom ISO code — Intl throws, so format manually.
    const fixed = value.toFixed(compact ? 0 : meta.decimals);
    return `${meta.symbol} ${fixed}`;
  }
}

/**
 * Converts between currencies using rates quoted against a common base.
 * Both rates must share that base (we normalise everything to USD on ingest).
 */
export function convertMinor(
  minor: number,
  from: string,
  to: string,
  ratesFromBase: Record<string, number>,
): number {
  if (from === to) return minor;
  const fromRate = ratesFromBase[from.toUpperCase()];
  const toRate = ratesFromBase[to.toUpperCase()];
  if (!fromRate || !toRate) {
    throw new Error(`Missing exchange rate for ${!fromRate ? from : to}`);
  }
  const major = toMajorUnits(minor, from);
  const converted = (major / fromRate) * toRate;
  return toMinorUnits(converted, to);
}
