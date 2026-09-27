import { Prisma } from '@prisma/client';
import { toJsonSafe } from './serialize';

/**
 * These exist because the data export shipped broken: it handed Prisma rows
 * straight to JSON.stringify, so it returned 500 "Do not know how to serialize
 * a BigInt" for every user who had so much as one expense, and 200 only for an
 * account with no financial data at all. Each case below is that failure or one
 * of its neighbours.
 */
describe('toJsonSafe', () => {
  const stringify = (value: unknown) => JSON.stringify(toJsonSafe(value));

  it('converts bigint to a number JSON accepts', () => {
    expect(stringify({ amountMinor: 12345n })).toBe('{"amountMinor":12345}');
  });

  it('converts Prisma Decimal to a number, not the string it defaults to', () => {
    // Left alone, Decimal serialises as "3.75" — a string where every other
    // route in the API emits a number for the same column.
    expect(stringify({ interestRateApr: new Prisma.Decimal('3.750') })).toBe(
      '{"interestRateApr":3.75}',
    );
  });

  it('converts Date to ISO 8601', () => {
    expect(stringify({ date: new Date('2026-09-01T00:00:00.000Z') })).toBe(
      '{"date":"2026-09-01T00:00:00.000Z"}',
    );
  });

  it('reaches values nested in arrays and objects', () => {
    const row = { budgets: [{ lines: [{ limitMinor: 5000n }] }] };
    expect(stringify(row)).toBe('{"budgets":[{"lines":[{"limitMinor":5000}]}]}');
  });

  it('preserves null and does not invent a value for undefined', () => {
    expect(stringify({ deletedAt: null, notes: undefined })).toBe(
      '{"deletedAt":null,"notes":null}',
    );
  });

  it('leaves strings, numbers and booleans untouched', () => {
    expect(stringify({ a: 'x', b: 1, c: true })).toBe('{"a":"x","b":1,"c":true}');
  });

  it('throws rather than silently truncating a bigint past 2^53', () => {
    // Corrupt data, not a wealthy user — and a truncated amount in a backup is
    // worse than a failed download, because nothing about it looks wrong.
    expect(() => toJsonSafe({ amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n })).toThrow(
      RangeError,
    );
  });

  it('refuses binary rather than guessing an encoding', () => {
    expect(() => toJsonSafe({ blob: Buffer.from('x') })).toThrow(TypeError);
  });
});
