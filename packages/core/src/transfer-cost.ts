import { toMajorUnits } from '@eco/shared';

/**
 * What moving money between currencies cost, when nobody stated a fee.
 *
 * A top-up from a dollar account into a riyal wallet is announced twice: the
 * bank states the dollars that left, the wallet states the riyals that
 * arrived. Neither mentions a charge, and the balance chain cannot find one
 * either — the bank took exactly what it said it took. The cost is in the
 * rate: the riyals were bought dearer than the market sells them. Converting
 * what arrived back at the market rate gives what it was worth; the
 * difference from what was paid is the cost.
 */

export interface CrossCurrencyMove {
  sentMinor: number;
  sentCurrency: string;
  receivedMinor: number;
  receivedCurrency: string;
  /** What arrived, converted into the sent currency at the market rate. */
  fairSentMinor: number;
}

export interface MoveCost {
  /** Paid above what the arriving money was worth; negative is a gain. */
  costMinor: number;
  /** costMinor as a percentage of the fair value, to two places. */
  costPct: number;
  /** Units received per unit sent, as this move actually priced it. */
  effectiveRate: number;
  /** Units received per unit sent at the market. */
  marketRate: number;
}

export function moveCost(move: CrossCurrencyMove): MoveCost | null {
  if (move.sentMinor <= 0 || move.receivedMinor <= 0 || move.fairSentMinor <= 0) return null;
  const sent = toMajorUnits(move.sentMinor, move.sentCurrency);
  const received = toMajorUnits(move.receivedMinor, move.receivedCurrency);
  const fair = toMajorUnits(move.fairSentMinor, move.sentCurrency);
  const costMinor = move.sentMinor - move.fairSentMinor;
  return {
    costMinor,
    costPct: Math.round((costMinor / move.fairSentMinor) * 10_000) / 100,
    effectiveRate: round4(received / sent),
    marketRate: round4(received / fair),
  };
}

/**
 * How far apart two halves of a move may price it and still be one move.
 *
 * Wider than any plausible margin — urpay's runs near 1% — and far narrower
 * than the distance between two different top-ups, so a 750-riyal message is
 * never joined to a 2,000-riyal one on the same day.
 */
export const MAX_PAIRING_DEVIATION_PCT = 5;

/** Whether a sent half and a received half plausibly describe one move. */
export function plausiblePair(move: CrossCurrencyMove): boolean {
  const cost = moveCost(move);
  return cost !== null && Math.abs(cost.costPct) <= MAX_PAIRING_DEVIATION_PCT;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
