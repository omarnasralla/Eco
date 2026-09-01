/**
 * Prisma maps BIGINT columns to JavaScript `bigint`, which JSON.stringify
 * refuses to serialise.  Rather than patch BigInt.prototype globally — which
 * would silently turn every amount into a string and break the client's
 * arithmetic — every mapper converts explicitly through these helpers.
 */

/** 2^53 − 1: the largest integer a JSON number represents exactly. */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function toNumber(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (value > MAX_SAFE || value < -MAX_SAFE) {
    // ~90 trillion in major units. Reaching here means corrupt data, not a
    // wealthy user, and silently truncating it would be the worse failure.
    throw new RangeError(`Monetary value ${value} exceeds safe JSON integer range`);
  }
  return Number(value);
}

export function toNumberOrNull(value: bigint | null | undefined): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

export function toBigInt(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(Math.round(value));
}

/** Prisma Decimal (or a plain number) → JS number, for rates and percentages. */
export function decimalToNumber(value: { toNumber(): number } | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : value.toNumber();
}
