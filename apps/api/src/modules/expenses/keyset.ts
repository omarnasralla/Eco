import type { Prisma } from '@prisma/client';

/**
 * The columns a chronological sort is keyed on, widest first.
 *
 * `date` is a DATE, so it ties for every row spent on the same day. Those ties
 * used to break on `id`, which is a random uuid: a day's rows came back in an
 * arbitrary order, and the purchase you made an hour ago could sit below one
 * from the morning. Breaking on `createdAt` orders a day the way it happened,
 * and `id` stays on the end to keep the key unique — two captures can share a
 * millisecond, and a keyset with a non-unique key skips rows.
 */
export type SortKey = 'date' | 'createdAt' | 'id';

export function sortKeys(sort: string): SortKey[] {
  return sort === 'created' ? ['createdAt', 'id'] : ['date', 'createdAt', 'id'];
}

/**
 * Opaque keyset cursor: `<iso date>|<iso createdAt>|<id>`, base64url encoded.
 *
 * It carries every column either chronological sort can key on, so one
 * encoding serves both. Two-part cursors were issued before a day's ties broke
 * on `createdAt`; `decodeCursor` still reads them so a list already open when
 * this deploys keeps scrolling, and reports which form it found so the keyset
 * matches the cursor it was given rather than assuming a field it lacks.
 */
export function encodeCursor(row: { date: Date; createdAt: Date; id: string }): string {
  return Buffer.from(
    `${row.date.toISOString()}|${row.createdAt.toISOString()}|${row.id}`,
  ).toString('base64url');
}

export type DecodedCursor = { values: Record<SortKey, Date | string>; legacy: boolean };

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const id = parts.pop();
    const [first, second] = parts;
    if (!id || !first) return null;
    const date = new Date(first);
    if (Number.isNaN(date.getTime())) return null;
    // One timestamp plus an id: the old form. Whichever column that sort keyed
    // on, the value belongs to it, so both slots take it and the caller drops
    // the one its sort does not use.
    const createdAt = second ? new Date(second) : date;
    if (Number.isNaN(createdAt.getTime())) return null;
    return { values: { date, createdAt, id }, legacy: second === undefined };
  } catch {
    return null;
  }
}

/**
 * `(a < A) OR (a = A AND b < B) OR (a = A AND b = B AND c < C)` — the row
 * strictly after the cursor under this ordering, for any number of keys.
 */
export function keysetAfter(
  keys: SortKey[],
  values: Record<SortKey, Date | string>,
  comparator: 'lt' | 'gt',
): Prisma.ExpenseWhereInput {
  return {
    OR: keys.map((key, i) => {
      const clause: Record<string, unknown> = {};
      for (const earlier of keys.slice(0, i)) clause[earlier] = values[earlier];
      clause[key] = { [comparator]: values[key] };
      return clause as Prisma.ExpenseWhereInput;
    }),
  };
}
