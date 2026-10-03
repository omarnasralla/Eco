import { decodeCursor, encodeCursor, keysetAfter, sortKeys } from './keyset';

const row = (date: string, createdAt: string, id: string) => ({
  date: new Date(date),
  createdAt: new Date(createdAt),
  id,
});

describe('sortKeys', () => {
  it('breaks a day of spending by when each row was captured', () => {
    expect(sortKeys('date')).toEqual(['date', 'createdAt', 'id']);
  });

  it('keys the entry order on createdAt alone', () => {
    expect(sortKeys('created')).toEqual(['createdAt', 'id']);
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips every key', () => {
    const r = row('2026-10-03', '2026-10-03T12:47:39.161Z', 'abc');
    const decoded = decodeCursor(encodeCursor(r));
    expect(decoded?.legacy).toBe(false);
    expect(decoded?.values).toEqual({ date: r.date, createdAt: r.createdAt, id: 'abc' });
  });

  it('is opaque — no field survives in readable form', () => {
    expect(encodeCursor(row('2026-10-03', '2026-10-03T12:47:39.161Z', 'abc'))).not.toContain('abc');
  });

  it('still reads a two-part cursor, and says so', () => {
    // Issued before createdAt joined the key list. A list left open across the
    // deploy keeps scrolling instead of erroring.
    const legacy = Buffer.from('2026-10-03T00:00:00.000Z|abc').toString('base64url');
    const decoded = decodeCursor(legacy);
    expect(decoded?.legacy).toBe(true);
    expect(decoded?.values.id).toBe('abc');
    // Both timestamp slots take the one value present, so whichever column
    // that sort keyed on reads the right thing.
    expect(decoded?.values.date).toEqual(decoded?.values.createdAt);
  });

  it('refuses a cursor that is not one of ours', () => {
    expect(decodeCursor('not-base64-at-all!!')).toBeNull();
    expect(decodeCursor(Buffer.from('|').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('nonsense|abc').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-10-03|nonsense|abc').toString('base64url'))).toBeNull();
  });
});

describe('keysetAfter', () => {
  const values = {
    date: new Date('2026-10-03'),
    createdAt: new Date('2026-10-03T12:47:39.161Z'),
    id: 'abc',
  };

  it('asks for the row strictly after the cursor, descending', () => {
    expect(keysetAfter(['date', 'createdAt', 'id'], values, 'lt')).toEqual({
      OR: [
        { date: { lt: values.date } },
        { date: values.date, createdAt: { lt: values.createdAt } },
        { date: values.date, createdAt: values.createdAt, id: { lt: 'abc' } },
      ],
    });
  });

  it('flips to ascending without changing shape', () => {
    expect(keysetAfter(['createdAt', 'id'], values, 'gt')).toEqual({
      OR: [
        { createdAt: { gt: values.createdAt } },
        { createdAt: values.createdAt, id: { gt: 'abc' } },
      ],
    });
  });

  it('names one clause per key, each pinning every key before it', () => {
    // This is what stops a page skipping or repeating rows: no two clauses can
    // match the same row, and together they cover everything after the cursor.
    const { OR } = keysetAfter(['date', 'createdAt', 'id'], values, 'lt') as {
      OR: Record<string, unknown>[];
    };
    expect(OR.map((clause) => Object.keys(clause))).toEqual([
      ['date'],
      ['date', 'createdAt'],
      ['date', 'createdAt', 'id'],
    ]);
  });
});
