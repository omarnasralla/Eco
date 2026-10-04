import { parseTransactionSms } from './sms-parser';

/**
 * Real messages from the two cards in use, kept verbatim — including the
 * trailing space after the amount on the first, which is exactly the kind of
 * detail a parser written against a tidied-up copy gets wrong.
 */
const MAIN = `Online Purchase
By:1360; VISA; Apple Pay
Amount:10.62 SAR 
At:Jeeny
28-9-2026 09:44`;

const NEO =
  'Your card ending with 0363 is approved for SAR 76.13 at STCC RTL 71089 RIYADH SA on 17/08/2026 at 12:31 AM.';

describe('parseTransactionSms', () => {
  it('reads the labelled-line format', () => {
    expect(parseTransactionSms(MAIN)).toEqual({
      kind: 'SPEND',
      amountMinor: 1062,
      currency: 'SAR',
      merchant: 'Jeeny',
      cardLast4: '1360',
      date: '2026-09-28',
    });
  });

  it('reads the approved-sentence format', () => {
    expect(parseTransactionSms(NEO)).toEqual({
      kind: 'SPEND',
      amountMinor: 7613,
      currency: 'SAR',
      merchant: 'STCC RTL 71089 RIYADH SA',
      cardLast4: '0363',
      date: '2026-08-17',
    });
  });

  it('pads a single-digit day and month', () => {
    // "28-9-2026" is September, not the 28th month.
    expect(parseTransactionSms(MAIN)?.date).toBe('2026-09-28');
  });

  it('keeps a merchant containing the word "on"', () => {
    const text =
      'Your card ending with 0363 is approved for SAR 12.00 at Bonjour Station on 01/02/2026 at 3:00 PM.';
    expect(parseTransactionSms(text)?.merchant).toBe('Bonjour Station');
  });

  it('handles a thousands separator', () => {
    const text =
      'Your card ending with 0363 is approved for SAR 1,234.56 at Somewhere on 01/02/2026 at 3:00 PM.';
    expect(parseTransactionSms(text)?.amountMinor).toBe(123456);
  });

  // The real messages from the urpay card, one of each type. The Refund and
  // the PoS Purchase below are the same 7.00 SAR at the same merchant at the
  // same minute — they differ only in the first word, which is the whole
  // reason the type is read before the amount.
  const REFUND = `Refund
At:FASTWAY ..
Card:3367; MADA
Amount:7.0 SAR
27-09-2026 19:30`;

  const POS = `PoS Purchase
By:3367;MADA;Apple Pay
Amount:7.0 SAR
At:FASTWAY ..
27-09-2026 19:30`;

  const SENT = `Debit via Wallet
To: JOE
Amount: 35 SAR
Date: 27-9-2026 19:56`;

  const RECEIVED = `Credit via Wallet
From: JOE KEEDY
Amount: 33 SAR
Date: 23-9-2026 20:07`;

  const TOPUP = `Top Up to urpay
Amount:200 SAR
Via:0115 - Visa
27-9-2026 11:53`;

  it('tells a refund from the purchase it reverses', () => {
    const refund = parseTransactionSms(REFUND)!;
    const pos = parseTransactionSms(POS)!;
    expect(refund.kind).toBe('RECEIVE');
    expect(pos.kind).toBe('SPEND');
    // Identical in every other respect — which is the trap.
    expect(refund.amountMinor).toBe(700);
    expect(pos.amountMinor).toBe(700);
    expect(refund.merchant).toBe('FASTWAY');
    expect(pos.merchant).toBe('FASTWAY');
    expect(refund.date).toBe('2026-09-27');
    expect(pos.date).toBe('2026-09-27');
  });

  it('reads the card from By:, Card: and Via: alike', () => {
    expect(parseTransactionSms(POS)?.cardLast4).toBe('3367');
    expect(parseTransactionSms(REFUND)?.cardLast4).toBe('3367');
    expect(parseTransactionSms(TOPUP)?.cardLast4).toBe('0115');
  });

  it('reads wallet transfers in both directions, naming the person', () => {
    expect(parseTransactionSms(SENT)).toMatchObject({
      kind: 'SPEND',
      amountMinor: 3500,
      merchant: 'JOE',
      date: '2026-09-27',
    });
    expect(parseTransactionSms(RECEIVED)).toMatchObject({
      kind: 'RECEIVE',
      amountMinor: 3300,
      merchant: 'JOE KEEDY',
      date: '2026-09-23',
    });
  });

  it('marks a top up as movement inside one account', () => {
    // Bank account to e-wallet. Recording it would count the money twice.
    expect(parseTransactionSms(TOPUP)?.kind).toBe('IGNORE');
  });

  /**
   * The real message, verbatim — the one that arrived unparsed on 4 Oct and
   * had to be cancelled by hand. Note the currency code BEFORE the number and
   * the labelled `Date:`, neither of which the purchase format uses.
   */
  const REVERSAL = `Reversed Transaction
Card: 1360
Amount: SAR 11.84
At: Jeeny
Date: 4-10-2026 09:18`;

  it('reads a reversal, code-first amount and all', () => {
    expect(parseTransactionSms(REVERSAL)).toEqual({
      kind: 'REVERSAL',
      amountMinor: 1184,
      currency: 'SAR',
      merchant: 'Jeeny',
      cardLast4: '1360',
      date: '2026-10-04',
    });
  });

  it('reads the same reversal flattened onto one line', () => {
    expect(parseTransactionSms(REVERSAL.replace(/\n/g, ' '))).toEqual(
      parseTransactionSms(REVERSAL),
    );
  });

  it('does not stop the merchant short, nor swallow the labelled date', () => {
    // `Date:` is a field label the purchase format does not use, so it has to
    // be a field boundary too — otherwise the merchant becomes "Jeeny Date".
    expect(parseTransactionSms(REVERSAL)?.merchant).toBe('Jeeny');
  });

  it('tells a reversal from a refund — they undo a charge differently', () => {
    // A refund is money arriving and belongs in the ledger; a reversal means
    // the money never left and the row should not exist.
    const refund = REVERSAL.replace('Reversed Transaction', 'Refund');
    expect(parseTransactionSms(refund)?.kind).toBe('RECEIVE');
    expect(parseTransactionSms(REVERSAL)?.kind).toBe('REVERSAL');
  });

  it('reads the amount with the code on either side of the number', () => {
    const codeFirst = parseTransactionSms(MAIN.replace('Amount:10.62 SAR', 'Amount: SAR 10.62'));
    expect(codeFirst?.amountMinor).toBe(1062);
    expect(codeFirst?.currency).toBe('SAR');
    expect(parseTransactionSms(MAIN)?.amountMinor).toBe(1062);
  });

  it('still requires a currency code, on whichever side', () => {
    expect(parseTransactionSms(MAIN.replace('Amount:10.62 SAR', 'Amount:10.62'))).toBeNull();
  });

  it('refuses an urpay message whose type it has never seen', () => {
    const unknown = `Salary Credited
At:EMPLOYER
Amount:5000 SAR
28-9-2026 09:00`;
    expect(parseTransactionSms(unknown)).toBeNull();
  });

  /**
   * How the messages ACTUALLY arrive. iOS flattens the newlines out before the
   * shortcut forwards them, so every field runs into the next on one line.
   * The multi-line cases above are the tidied form; these are the real one,
   * and the first version of this parser passed the former while turning
   * "At:Jeeny 28-9-2026 09:44" into a merchant of that whole string.
   */
  describe('as the phone actually sends them — one flat line', () => {
    it('stops the merchant at the date', () => {
      const flat =
        'Online Purchase By:1360; VISA; Apple Pay Amount:10.62 SAR  At:Jeeny 28-9-2026 09:44';
      expect(parseTransactionSms(flat)).toEqual({
        kind: 'SPEND',
        amountMinor: 1062,
        currency: 'SAR',
        merchant: 'Jeeny',
        cardLast4: '1360',
        date: '2026-09-28',
      });
    });

    it('stops the merchant at the next label', () => {
      const flat = 'Refund At:FASTWAY .. Card:3367; MADA Amount:7.0 SAR 27-09-2026 19:30';
      expect(parseTransactionSms(flat)).toMatchObject({
        kind: 'RECEIVE',
        merchant: 'FASTWAY',
        cardLast4: '3367',
        amountMinor: 700,
      });
    });

    it('reads a flattened PoS purchase', () => {
      const flat =
        'PoS Purchase By:3367;MADA;Apple Pay Amount:7.0 SAR At:FASTWAY .. 27-09-2026 19:30';
      expect(parseTransactionSms(flat)).toMatchObject({
        kind: 'SPEND',
        merchant: 'FASTWAY',
        amountMinor: 700,
      });
    });

    it('reads flattened wallet transfers, keeping a two-word name', () => {
      expect(
        parseTransactionSms('Debit via Wallet To: JOE Amount: 35 SAR Date: 27-9-2026 19:56'),
      ).toMatchObject({ kind: 'SPEND', merchant: 'JOE', amountMinor: 3500 });
      expect(
        parseTransactionSms(
          'Credit via Wallet From: JOE KEEDY Amount: 33 SAR Date: 23-9-2026 20:07',
        ),
      ).toMatchObject({ kind: 'RECEIVE', merchant: 'JOE KEEDY', amountMinor: 3300 });
    });

    it('reads a flattened top up', () => {
      expect(
        parseTransactionSms('Top Up to urpay Amount:200 SAR Via:0115 - Visa 27-9-2026 11:53'),
      ).toMatchObject({ kind: 'IGNORE', cardLast4: '0115' });
    });
  });

  it('returns null for a message that is not a transaction', () => {
    // Refused rather than half-read: recording a wrong amount silently is
    // worse than a message that needs a new pattern added.
    expect(parseTransactionSms('Your OTP is 481920. Do not share it.')).toBeNull();
    expect(parseTransactionSms('Welcome to our new app! Download now.')).toBeNull();
    expect(parseTransactionSms('')).toBeNull();
    expect(parseTransactionSms('   ')).toBeNull();
  });
});
