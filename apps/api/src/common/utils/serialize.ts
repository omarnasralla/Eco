import { Prisma } from '@prisma/client';
import { toNumber } from './money';

/**
 * Deep-converts Prisma rows into values `JSON.stringify` accepts.
 *
 * Hand-written mappers are the rule everywhere else in this API, and they stay
 * the rule: a DTO is a deliberate choice about what leaves the server. The data
 * export is the one place that choice is "the row, whole" — it exists to hand
 * the user back what we hold — and there a mapper per model is the wrong shape.
 * Twelve of them would drift out of date the first time a column is added, and
 * the failure is silent: the export quietly stops containing a field.
 *
 * So this walks the structure instead, converting only the three types Prisma
 * produces that JSON cannot represent:
 *
 *   bigint   → number, through `toNumber`, which throws rather than silently
 *              truncating past 2^53. Patching `BigInt.prototype.toJSON` would
 *              be the shorter fix and a much worse one — it is global, so every
 *              amount in every response turns into a string and the client's
 *              arithmetic breaks far from here. See money.ts.
 *   Decimal  → number. Prisma's Decimal serialises to a *string* by default,
 *              which would make `interestRateApr` "3.75" in the export and a
 *              number everywhere else in the API.
 *   Date     → ISO 8601 string, matching every other date this API emits.
 *
 * Buffers are rejected rather than encoded: no exported model holds one today,
 * and guessing at base64 for a column added later is worse than a loud failure.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;

  if (typeof value === 'bigint') return toNumber(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toNumber();

  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item));

  if (Buffer.isBuffer(value)) {
    throw new TypeError('Binary column reached the data export; add an explicit encoding for it');
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(item);
    }
    return out;
  }

  return value;
}
