import { parseAmountToMinor } from '../../common/utils/parse-amount';

/**
 * What the message says happened — the single most important field here.
 *
 * SPEND and RECEIVE differ only by the word on the first line: a Refund and a
 * PoS Purchase carry the same merchant, the same amount and the same
 * timestamp. Reading the amount without reading the type files money coming
 * back as money going out, which is wrong twice over.
 *
 * IGNORE is for movement inside one account — topping the wallet up from the
 * bank account behind it. Nothing entered or left; recording it would count
 * the same riyals a second time.
 *
 * REVERSAL is not a transaction of its own: the bank is saying a charge it
 * already told us about never happened. It cancels that charge rather than
 * recording anything, which is why it cannot be folded into RECEIVE — money
 * coming back is a refund and belongs in the ledger, whereas a reversal means
 * the money never left and the row should not be there at all.
 */
export type SmsKind = 'SPEND' | 'RECEIVE' | 'IGNORE' | 'REVERSAL';

/** One transaction, read out of a bank's SMS alert. */
export interface ParsedSms {
  kind: SmsKind;
  amountMinor: number;
  currency: string;
  merchant: string;
  /** Last four digits of the card, which is what maps to an account. */
  cardLast4: string | null;
  /** The date the bank stated, as YYYY-MM-DD. */
  date: string;
}

/**
 * The first line of an urpay alert says what it is. Matched before anything
 * else is read, so a Refund can never be mistaken for the purchase it
 * reverses — the two are otherwise identical.
 */
const URPAY_KINDS: Array<{ match: RegExp; kind: SmsKind }> = [
  { match: /^\s*(online|pos)\s+purchase/i, kind: 'SPEND' },
  { match: /^\s*refund/i, kind: 'RECEIVE' },
  // "Reversed Transaction" — the charge is being withdrawn, not repaid.
  { match: /^\s*revers(ed|al)/i, kind: 'REVERSAL' },
  { match: /^\s*debit via wallet/i, kind: 'SPEND' },
  { match: /^\s*credit via wallet/i, kind: 'RECEIVE' },
  // Bank account to e-wallet: the same account either side.
  { match: /^\s*top\s*up/i, kind: 'IGNORE' },
];

/**
 * Bank SMS alerts, read server side.
 *
 * The phone forwards the message unchanged and the parsing happens here, not
 * in a text action on the phone — this is where it can be tested against real
 * messages, and where a bank changing its wording is a failing test rather
 * than expenses that quietly stop arriving.
 *
 * Every format is explicit. An unrecognised message is refused, loudly, rather
 * than half-read: a wrong amount recorded silently is worse than a message
 * that needs a new pattern, and the refusal is what tells us to add one.
 */
const PATTERNS: Array<{ name: string; parse: (text: string) => ParsedSms | null }> = [
  {
    // Online Purchase
    // By:1360; VISA; Apple Pay
    // Amount:10.62 SAR
    // At:Jeeny
    // 28-9-2026 09:44
    name: 'labelled-lines',
    parse: (text) => {
      // The type comes first. An unrecognised first line is not parsed at all:
      // a new message type must be read by a human before it moves money.
      const kind = URPAY_KINDS.find((k) => k.match.test(text))?.kind;
      if (!kind) return null;

      // The code sits after the number on a purchase ("Amount:11.84 SAR") and
      // before it on a reversal ("Amount: SAR 11.84"). Same bank, same alert
      // family, two orders — so both are read rather than one being the rule.
      const amount = AMOUNT.exec(text);
      const date = /(\d{1,2})-(\d{1,2})-(\d{4})/.exec(text);
      if (!amount || !date) return null;
      const [, codeFirst, afterCode, numberFirst, afterNumber] = amount;

      // Purchases and refunds name a merchant with "At:"; wallet transfers
      // name a person with "To:" or "From:". A top up names neither — there is
      // no counterparty when money moves between two pockets of one account —
      // so it is the one type allowed to arrive without one.
      const counterparty = labelled(text, ['At', 'To', 'From']);
      if (counterparty === null && kind !== 'IGNORE') return null;

      // "By:" on a purchase, "Card:" on a refund, "Via:" on a top up.
      const card = /(?:By|Card|Via):\s*(\d{3,4})/i.exec(text);
      const currency = (codeFirst ?? afterNumber)!.toUpperCase();
      return {
        kind,
        amountMinor: parseAmountToMinor((afterCode ?? numberFirst)!, currency),
        currency,
        merchant: counterparty ?? 'Top up',
        cardLast4: card ? card[1]!.slice(-4) : null,
        date: iso(date[3]!, date[2]!, date[1]!),
      };
    },
  },
  {
    // Your card ending with 0363 is approved for SAR 76.13 at STCC RTL 71089
    // RIYADH SA on 17/08/2026 at 12:31 AM.
    name: 'approved-sentence',
    parse: (text) => {
      // The merchant is lazy and anchored on " on <date>", because a merchant
      // name can itself contain the word "on".
      const m =
        /card ending with\s*(\d{3,4})\s*is approved for\s*([A-Za-z]{3})\s*([\d.,]+)\s*at\s*(.+?)\s*on\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(
          text,
        );
      if (!m) return null;

      const currency = m[2]!.toUpperCase();
      return {
        kind: 'SPEND',
        amountMinor: parseAmountToMinor(m[3]!, currency),
        currency,
        merchant: clean(m[4]!),
        cardLast4: m[1]!.slice(-4),
        date: iso(m[7]!, m[6]!, m[5]!),
      };
    },
  },
];

/**
 * Read a transaction out of an SMS, or return null if no pattern fits.
 *
 * Null is the honest answer for an unknown message — a transfer, a one-time
 * password, a marketing text. The caller refuses it rather than guessing.
 */
export function parseTransactionSms(text: string): ParsedSms | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const pattern of PATTERNS) {
    try {
      const parsed = pattern.parse(trimmed);
      if (parsed) return parsed;
    } catch {
      // A pattern that matches the shape but not the content — an amount that
      // will not parse — is not a match. Try the next one.
      continue;
    }
  }
  return null;
}

/**
 * The value of a labelled field, ending where the next field begins.
 *
 * The message arrives from the phone as ONE line — iOS flattens the newlines
 * out before forwarding it — so "ends at the end of the line" is not a rule
 * that exists here. Reading to the end of the input instead swallowed whatever
 * followed, and "At:Jeeny 28-9-2026 09:44" became a merchant called
 * "Jeeny 28-9-2026 09:44".
 *
 * So a value ends at the next known label, at a date, or at the end of the
 * text — whichever comes first. Works on the flattened form and on the
 * original multi-line one alike.
 */
/**
 * `Amount:` with its currency code on either side of the number.
 *
 * Two alternatives rather than an optional code on each end, so exactly one
 * code is required and the capture groups say which order was found.
 */
const AMOUNT = /Amount:\s*(?:([A-Za-z]{3})\s*([\d.,]+)|([\d.,]+)\s*([A-Za-z]{3}))/i;

const FIELD_END = /\s*(?:\d{1,2}[-/]\d{1,2}[-/]\d{4}|By:|Card:|Via:|Amount:|Date:|At:|To:|From:)|\s*$/i;

function labelled(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const start = new RegExp(`${label}:\\s*`, 'i').exec(text);
    if (!start) continue;
    const rest = text.slice(start.index + start[0].length);
    const end = FIELD_END.exec(rest);
    const value = clean(end && end.index > 0 ? rest.slice(0, end.index) : rest);
    if (value) return value;
  }
  return null;
}

/** Trailing punctuation and collapsed whitespace; the name is otherwise kept. */
function clean(merchant: string): string {
  return merchant.replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
}

function iso(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
