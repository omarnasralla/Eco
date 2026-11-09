import { describe, expect, it } from 'vitest';
import { moveCost, plausiblePair } from './transfer-cost';

describe('moveCost', () => {
  it('reads the 9 Nov urpay top-up: $995.92 for SAR 3,700 at the 3.75 peg', () => {
    // SAR 3,700 / 3.75 = $986.67 — what the riyals were worth.
    expect(
      moveCost({
        sentMinor: 99_592,
        sentCurrency: 'USD',
        receivedMinor: 370_000,
        receivedCurrency: 'SAR',
        fairSentMinor: 98_667,
      }),
    ).toEqual({ costMinor: 925, costPct: 0.94, effectiveRate: 3.7152, marketRate: 3.75 });
  });

  it('reports a better-than-market rate as a negative cost, not zero', () => {
    const cost = moveCost({
      sentMinor: 10_000,
      sentCurrency: 'USD',
      receivedMinor: 38_000,
      receivedCurrency: 'SAR',
      fairSentMinor: 10_133,
    });
    expect(cost?.costMinor).toBe(-133);
  });

  it('declines to price a move with a missing side', () => {
    expect(
      moveCost({
        sentMinor: 0,
        sentCurrency: 'USD',
        receivedMinor: 370_000,
        receivedCurrency: 'SAR',
        fairSentMinor: 98_667,
      }),
    ).toBeNull();
  });
});

describe('plausiblePair', () => {
  const sent = { sentMinor: 99_592, sentCurrency: 'USD', receivedCurrency: 'SAR' };

  it('joins two halves of one top-up', () => {
    expect(plausiblePair({ ...sent, receivedMinor: 370_000, fairSentMinor: 98_667 })).toBe(true);
  });

  it('refuses to join a top-up to a different one on the same day', () => {
    // SAR 750 is worth $200 — nowhere near the $995.92 that left.
    expect(plausiblePair({ ...sent, receivedMinor: 75_000, fairSentMinor: 20_000 })).toBe(false);
  });
});
