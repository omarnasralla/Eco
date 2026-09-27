import { BadRequestException } from '@nestjs/common';
import { CURRENCIES, currencyMeta, toMinorUnits } from '@eco/shared';

/**
 * Turn whatever a phone sent into minor units.
 *
 * The iOS Wallet automation hands a shortcut the amount as *display text* —
 * "$12.34", "1,234.56", "﷼ 45" — not a number. Asking the user to strip that
 * down with Shortcuts' text actions is where these setups break, so the
 * parsing happens here where it can be tested.
 *
 * The decimal separator cannot be assumed: "1.234" is a thousand-odd in Beirut
 * and one-and-a-bit in Boston. So the currency decides. The last separator in
 * the string is the decimal point only if the digits after it would fit the
 * currency's own scale — which is why this takes a currency at all:
 *
 *   "1,234.56"  USD (2dp) → 123456   the .56 fits, the comma groups
 *   "1.234,56"  EUR (2dp) → 123456   the ,56 fits, the dot groups
 *   "150,000"   LBP (0dp) → 150000   no decimals exist; both separators group
 *   "0.500"     KWD (3dp) →    500   three decimals are real here
 *   "1,234"     USD (2dp) → 123400   three digits cannot be cents
 *
 * Refunds are refused rather than guessed at. A negative tap could mean money
 * came back, or it could mean the phone formatted something oddly, and a
 * wrongly-signed row is worse than a rejected one the user can see and fix.
 */
export function parseAmountToMinor(raw: string | number, currency: string): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new BadRequestException('Amount is not a number');
    if (raw < 0) throw new BadRequestException(REFUND_MESSAGE);
    return toMinorUnits(raw, currency);
  }

  const text = raw.trim();
  if (text === '') throw new BadRequestException('Amount is empty');

  // Accountants' parentheses, and a plain leading minus, both mean negative.
  const negative = /^\(.*\)$/.test(text) || text.includes('-');

  // Everything that is not a digit or a separator is currency decoration:
  // symbols, codes, spaces, the non-breaking kind included.
  const cleaned = text.replace(/[^0-9.,]/g, '');
  if (cleaned === '') throw new BadRequestException(`Could not read an amount from "${text}"`);

  const decimals = currencyMeta(currency).decimals;
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');
  const lastSeparator = Math.max(lastDot, lastComma);

  let normalised: string;
  if (decimals === 0 || lastSeparator === -1) {
    // No fractional part exists in this currency, so every separator groups.
    normalised = cleaned.replace(/[.,]/g, '');
  } else {
    const digitsAfter = cleaned.length - lastSeparator - 1;
    if (digitsAfter >= 1 && digitsAfter <= decimals) {
      const whole = cleaned.slice(0, lastSeparator).replace(/[.,]/g, '');
      normalised = `${whole}.${cleaned.slice(lastSeparator + 1)}`;
    } else {
      normalised = cleaned.replace(/[.,]/g, '');
    }
  }

  const value = Number(normalised);
  if (!Number.isFinite(value)) {
    throw new BadRequestException(`Could not read an amount from "${text}"`);
  }
  if (negative) throw new BadRequestException(REFUND_MESSAGE);

  const minor = toMinorUnits(value, currency);
  if (minor === 0) throw new BadRequestException('Amount is zero');
  return minor;
}

const REFUND_MESSAGE =
  'That looks like a refund. Refunds are not captured automatically yet — add it as income, or reconcile the account.';


/**
 * The currency named inside an amount string, if it names one unambiguously.
 *
 * The Wallet automation sends the amount as the phone displays it — "SAR 3.00",
 * "﷼3.00" — and that text is the only place the currency appears. Without this
 * a 3 SAR tap on a dollar account is recorded as $3.00, roughly four times what
 * was actually spent, and nothing about the row looks wrong afterwards.
 *
 * Only unambiguous markers count. "$" is deliberately ignored: it is the US,
 * Canadian and Australian dollar at once, and guessing wrong here is the exact
 * failure this exists to prevent. When nothing is certain it returns null and
 * the caller falls back to the account's own currency.
 */
export function detectCurrency(text: string): string | null {
  const upper = text.toUpperCase();

  // An explicit ISO code beats everything — it is the one unambiguous form.
  for (const currency of CURRENCIES) {
    if (new RegExp(`(^|[^A-Z])${currency.code}([^A-Z]|$)`).test(upper)) return currency.code;
  }

  // Symbols, but only those belonging to exactly one currency we know.
  const ambiguous = new Set(['$']);
  const bySymbol = new Map<string, string[]>();
  for (const currency of CURRENCIES) {
    const list = bySymbol.get(currency.symbol) ?? [];
    list.push(currency.code);
    bySymbol.set(currency.symbol, list);
  }
  for (const [symbol, codes] of bySymbol) {
    if (codes.length !== 1 || ambiguous.has(symbol)) continue;
    // Letters are never matched as symbols. The rand's symbol is a bare "R",
    // so a substring test found a currency in the word "SARDINE"; anything
    // spelled with letters is already covered by the ISO-code pass above.
    if (/[A-Za-z]/.test(symbol)) continue;
    if (text.includes(symbol)) return codes[0]!;
  }
  return null;
}
