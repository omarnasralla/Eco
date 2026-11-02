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
      fee: null,
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
      fee: null,
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

  it('reads a top up as a transfer, naming the wallet it went to', () => {
    // Bank account to e-wallet. It was IGNORE while one account stood for
    // both pockets — the move and the spending it funded were the same money.
    // With the wallet modelled separately, ignoring it leaves the wallet
    // spending riyals nobody gave it.
    expect(parseTransactionSms(TOPUP)).toMatchObject({
      kind: 'TRANSFER',
      amountMinor: 20000,
      currency: 'SAR',
      // The arriving side, in the wallet's own currency — the exact figure the
      // wallet's balance needs, which the funding bank's alert cannot give.
      merchant: 'urpay',
      cardLast4: '0115',
      date: '2026-09-27',
    });
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
      fee: null,
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

  /**
   * The real message, verbatim — the one that quietly stopped a monthly VPS
   * charge being recorded for twelve days. Note there is NO date line, and
   * that `Fees/VAT:` appears BEFORE `At:`.
   */
  const INTERNATIONAL = `International purchase
Country: Germany
Card:1360; VISA; 40060117200
Amount: 10.35 USD
Fees/VAT:SAR 1.12
At: CONTABO*..
`;

  it('reads an international purchase, in its own currency', () => {
    expect(parseTransactionSms(INTERNATIONAL)).toEqual({
      kind: 'SPEND',
      amountMinor: 1035,
      currency: 'USD',
      merchant: 'CONTABO',
      cardLast4: '1360',
      // The alert states no date; the caller files it on the day it arrived.
      date: null,
      fee: { amountMinor: 112, currency: 'SAR' },
    });
  });

  it('does not read the VAT amount as the merchant', () => {
    // `Fees/VAT:` ends in "AT:", and it comes before the real `At:` — so an
    // unanchored label matched it and the merchant became "SAR 1.12".
    expect(parseTransactionSms(INTERNATIONAL)?.merchant).toBe('CONTABO');
  });

  it('keeps the fee separate rather than adding two currencies', () => {
    const parsed = parseTransactionSms(INTERNATIONAL);
    expect(parsed?.amountMinor).toBe(1035);
    expect(parsed?.currency).toBe('USD');
    expect(parsed?.fee).toEqual({ amountMinor: 112, currency: 'SAR' });
  });

  it('reads an international purchase flattened onto one line', () => {
    expect(parseTransactionSms(INTERNATIONAL.replace(/\n/g, ' '))).toEqual(
      parseTransactionSms(INTERNATIONAL),
    );
  });

  it('strips the terminal padding from a merchant but not an inner asterisk', () => {
    expect(parseTransactionSms(INTERNATIONAL)?.merchant).toBe('CONTABO');
    const inner = INTERNATIONAL.replace('CONTABO*..', 'UBR* PEN');
    expect(parseTransactionSms(inner)?.merchant).toBe('UBR* PEN');
  });

  /**
   * A 3-D Secure code, sent BEFORE the payment goes through. It names an
   * amount and a merchant, and the real purchase alert arrives separately once
   * the payment completes — so reading this as a transaction double-counts
   * every online purchase.
   */
  const OTP = `Verification code: 696413
Service: Digital products
Amount:SAR 120.00
At:Amazon
2026-10-22 12:44
Don't share the code`;

  it('ignores a verification code rather than recording it twice', () => {
    expect(parseTransactionSms(OTP)).toEqual({
      kind: 'IGNORE',
      amountMinor: 12000,
      currency: 'SAR',
      merchant: 'Amazon',
      cardLast4: null,
      date: '2026-10-22',
      fee: null,
    });
  });

  it('reads a year-first date without reading the year as a day', () => {
    // "2026-10-22" under a day-first rule is day 2026 of month 10.
    expect(parseTransactionSms(OTP)?.date).toBe('2026-10-22');
    expect(parseTransactionSms(MAIN)?.date).toBe('2026-09-28');
  });

  /**
   * The real Neo notice, verbatim. It names a sender and no card at all, which
   * is why it is the one format that carries a channel instead.
   */
  const NEO_REQUEST =
    'DONIA HARB sent you USD 100.00 on 31/10/2026 at 12:55 PM. "Accept" or "Reject" ' +
    'via "Request" tab within 3 days or it will be canceled.';

  it('reads money sent by a person through Neo', () => {
    expect(parseTransactionSms(NEO_REQUEST)).toEqual({
      kind: 'RECEIVE',
      amountMinor: 10000,
      currency: 'USD',
      merchant: 'DONIA HARB',
      // No card anywhere in the message — the account is found by channel.
      cardLast4: null,
      date: '2026-10-31',
      fee: null,
      channel: 'neo-request',
    });
  });

  it('keeps a sender name of any length', () => {
    // Anchored on " sent you", because a name has no label and no fixed word
    // count — the only thing that reliably ends it is the phrase after it.
    expect(parseTransactionSms(NEO_REQUEST.replace('DONIA HARB', 'PIERRE'))?.merchant).toBe(
      'PIERRE',
    );
    expect(
      parseTransactionSms(NEO_REQUEST.replace('DONIA HARB', 'JEAN PAUL EL KHOURY'))?.merchant,
    ).toBe('JEAN PAUL EL KHOURY');
  });

  it('reads it as money arriving, not as money moved between your own accounts', () => {
    // It comes from another person, so RECEIVE. A top up comes from another
    // pocket of your own, so TRANSFER. Confusing the two would either invent
    // income or lose it.
    expect(parseTransactionSms(NEO_REQUEST)?.kind).toBe('RECEIVE');
    expect(parseTransactionSms(TOPUP)?.kind).toBe('TRANSFER');
  });

  it('reads the day-first date, not the month', () => {
    // 31/10 can only be the 31st of October; a month-first reading has no
    // 31st month, and this is the format that proves which rule applies.
    expect(parseTransactionSms(NEO_REQUEST)?.date).toBe('2026-10-31');
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
        fee: null,
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
      ).toMatchObject({ kind: 'TRANSFER', cardLast4: '0115', merchant: 'urpay' });
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
