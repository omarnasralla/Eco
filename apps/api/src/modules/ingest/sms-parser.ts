import { parseAmountToMinor } from '../../common/utils/parse-amount';

/**
 * What the message says happened — the single most important field here.
 *
 * SPEND and RECEIVE differ only by the word on the first line: a Refund and a
 * PoS Purchase carry the same merchant, the same amount and the same
 * timestamp. Reading the amount without reading the type files money coming
 * back as money going out, which is wrong twice over.
 *
 * IGNORE is for a message that states no movement at all.
 *
 * TRANSFER is money moving between two accounts the same person owns —
 * topping the Saudi wallet up from the Lebanese bank account behind it.
 * Nothing is spent and nothing is earned, so it is neither SPEND nor RECEIVE,
 * but it does leave one balance and arrive in another. It used to be IGNORE,
 * which was right while there was one account for both: the top-up and the
 * spending it funded were the same pocket, and recording the move would have
 * counted the same riyals twice. With the wallet modelled separately, ignoring
 * it leaves the wallet spending money it was never given.
 *
 * REVERSAL is not a transaction of its own: the bank is saying a charge it
 * already told us about never happened. It cancels that charge rather than
 * recording anything, which is why it cannot be folded into RECEIVE — money
 * coming back is a refund and belongs in the ledger, whereas a reversal means
 * the money never left and the row should not be there at all.
 */
export type SmsKind =
  | 'SPEND'
  | 'RECEIVE'
  | 'IGNORE'
  | 'REVERSAL'
  | 'BALANCE'
  | 'TRANSFER'
  /** Money announced before it moves — held until the alert that confirms it. */
  | 'PENDING';

/** One transaction, read out of a bank's SMS alert. */
export interface ParsedSms {
  kind: SmsKind;
  amountMinor: number;
  currency: string;
  merchant: string;
  /** Last four digits of the card, which is what maps to an account. */
  cardLast4: string | null;
  /**
   * The date the bank stated, as YYYY-MM-DD, or null when it stated none.
   *
   * The international-purchase alert carries no date at all, so the caller
   * falls back to the day it arrived. Null rather than silently today, because
   * "the bank did not say" and "the bank said today" are different facts and
   * only one of them is worth a note on the row.
   */
  date: string | null;
  /**
   * A separately-stated fee, in its own currency.
   *
   * A foreign purchase is billed as the amount plus a VAT line in riyals. Two
   * currencies cannot be added, so the fee is carried alongside rather than
   * folded into the total, and recorded where it can be seen.
   */
  fee: { amountMinor: number; currency: string } | null;
  /**
   * The balance the bank stated AFTER this movement, when it stated one.
   *
   * Only the funding account's alerts carry it, and it is the single most
   * useful number in any of these messages: chained against the next one it
   * says what a transfer actually cost, which no message ever states.
   *
   * Optional rather than nullable so the formats that carry no balance need
   * not mention it at all.
   */
  statedBalanceMinor?: number;
  /**
   * The bank channel this message came through, for the formats that name no
   * card.
   *
   * Every other alert identifies its account by the card in it. Neo's
   * person-to-person notice carries no account identifier at all, so the
   * account declares the channel instead and this is what it is matched on.
   */
  channel?: string;
}

/**
 * The channel urpay's card-less messages arrive on — wallet transfers and
 * verification codes, neither of which names the card the account is read by.
 */
export const URPAY_WALLET_CHANNEL = 'urpay-wallet';

/**
 * The first line of an urpay alert says what it is. Matched before anything
 * else is read, so a Refund can never be mistaken for the purchase it
 * reverses — the two are otherwise identical.
 */
const URPAY_KINDS: Array<{ match: RegExp; kind: SmsKind; channel?: string }> = [
  { match: /^\s*(online|pos)\s+purchase/i, kind: 'SPEND' },
  { match: /^\s*refund/i, kind: 'RECEIVE' },
  // "Reversed Transaction" — the charge is being withdrawn, not repaid.
  { match: /^\s*revers(ed|al)/i, kind: 'REVERSAL' },
  // A foreign card purchase. Same event as an Online Purchase, different
  // template: it adds Country and Fees/VAT, and states no date.
  { match: /^\s*international\s+purchase/i, kind: 'SPEND' },
  // A 3-D Secure one-time code, sent BEFORE the purchase goes through. Read
  // as a purchase it would double-count every online payment, since the real
  // alert usually follows. Usually: for some merchants none ever does — two
  // WHISH MONEY payments were lost while this was ignored. So it is held, and
  // becomes the purchase only if no alert claims it.
  { match: /^\s*verification\s+code/i, kind: 'PENDING', channel: URPAY_WALLET_CHANNEL },
  // Wallet to wallet, to or from a person. These name no card — the money
  // moves inside the wallet itself — so they carry the wallet's channel, and
  // the account that claims it receives them. Without one they fell back to
  // the primary account: riyals sent from urpay were filed against a dollar
  // bank in Beirut, and urpay's balance never went down.
  { match: /^\s*debit via wallet/i, kind: 'SPEND', channel: URPAY_WALLET_CHANNEL },
  { match: /^\s*credit via wallet/i, kind: 'RECEIVE', channel: URPAY_WALLET_CHANNEL },
  // Bank account to e-wallet. The amount stated is what ARRIVED, in the
  // wallet's own currency, which is the exact figure the wallet's balance
  // needs — so this message, not the funding bank's, is what records the move.
  { match: /^\s*top\s*up/i, kind: 'TRANSFER' },
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
      const type = URPAY_KINDS.find((k) => k.match.test(text));
      if (!type) return null;
      const kind = type.kind;

      // The code sits after the number on a purchase ("Amount:11.84 SAR") and
      // before it on a reversal ("Amount: SAR 11.84"). Same bank, same alert
      // family, two orders — so both are read rather than one being the rule.
      const amount = AMOUNT.exec(text);
      if (!amount) return null;
      const [, codeFirst, afterCode, numberFirst, afterNumber] = amount;

      // Purchases and refunds name a merchant with "At:"; wallet transfers
      // name a person with "To:" or "From:". A top up names neither — there is
      // no counterparty when money moves between two pockets of one account —
      // so it is the one type allowed to arrive without one.
      const counterparty = labelled(text, ['At', 'To', 'From']);
      // A top up names neither — there is no counterparty when money moves
      // between two of your own pockets — so it names its destination on the
      // first line instead: "Top Up to urpay".
      const destination = kind === 'TRANSFER' ? valueAfter(text, /top\s*up\s+to\s+/i) : null;
      if (counterparty === null && kind !== 'IGNORE' && kind !== 'TRANSFER') return null;

      // "By:" on a purchase, "Card:" on a refund, "Via:" on a top up.
      const card = /(?:By|Card|Via):\s*(\d{3,4})/i.exec(text);
      const currency = (codeFirst ?? afterNumber)!.toUpperCase();
      const fee = FEE.exec(text);
      const feeCurrency = fee ? (fee[1] ?? fee[4])!.toUpperCase() : null;
      return {
        kind,
        amountMinor: parseAmountToMinor((afterCode ?? numberFirst)!, currency),
        currency,
        merchant: counterparty ?? destination ?? 'Top up',
        cardLast4: card ? card[1]!.slice(-4) : null,
        // Only when no card names the account: a card is always the better
        // identifier, and a channel is the fallback for messages without one.
        ...(type.channel && !card ? { channel: type.channel } : {}),
        date: statedDate(text),
        fee:
          fee && feeCurrency
            ? {
                amountMinor: parseAmountToMinor((fee[2] ?? fee[3])!, feeCurrency),
                currency: feeCurrency,
              }
            : null,
      };
    },
  },
  {
    // DONIA HARB sent you USD 100.00 on 31/10/2026 at 12:55 PM. "Accept" or
    // "Reject" via "Request" tab within 3 days or it will be canceled.
    //
    // Money from a person, through Neo's transfer requests. RECEIVE, not
    // TRANSFER: it comes from someone else, not from another pocket of the
    // user's own.
    //
    // It names no card, which is why it carries a channel instead — the only
    // format here whose account cannot be read from the message.
    //
    // The three-day deadline is real and the money is cancelled without it, so
    // the caller notifies rather than only recording.
    name: 'neo-request',
    parse: (text) => {
      // The sender is lazy and anchored on " sent you", because a name can be
      // any number of words and is the one field with no label.
      const m =
        /^\s*(.+?)\s+sent you\s+([A-Za-z]{3})\s*([\d.,]+)\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(
          text,
        );
      if (!m) return null;

      const currency = m[2]!.toUpperCase();
      return {
        kind: 'RECEIVE',
        amountMinor: parseAmountToMinor(m[3]!, currency),
        currency,
        merchant: clean(m[1]!),
        cardLast4: null,
        date: iso(m[6]!, m[5]!, m[4]!),
        fee: null,
        channel: 'neo-request',
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
        fee: null,
      };
    },
  },
  {
    // Pls note a transaction was made on your card (ending 0115) for
    // USD202.01 at URPAYRIYADH SA Av.Bal:2533.45 on 23/10/2026. if not
    // yours,pls call:9611738800
    //
    // The funding account's own alert. BALANCE rather than SPEND on purpose:
    // this account pays for the wallet that the purchase alerts already come
    // from, so recording these as expenses would count the same money twice —
    // once leaving Beirut and again being spent in Riyadh. What it is worth
    // keeping is the balance, which is the only way to learn what a transfer
    // cost.
    name: 'balance-alert',
    parse: (text) => {
      // The merchant is lazy and anchored on " Av.Bal", because the name runs
      // two words together ("URPAYRIYADH SA") and has no delimiter of its own.
      const m =
        /transaction was made on your card\s*\(\s*ending\s*(\d{3,4})\s*\)\s*for\s*([A-Za-z]{3})\s*([\d.,]+)\s*at\s*(.+?)\s*Av\.?\s*Bal[.:\s]*([\d.,]+)\s*on\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(
          text,
        );
      if (!m) return null;

      const currency = m[2]!.toUpperCase();
      return {
        kind: 'BALANCE',
        amountMinor: parseAmountToMinor(m[3]!, currency),
        currency,
        merchant: clean(m[4]!),
        cardLast4: m[1]!.slice(-4),
        date: iso(m[8]!, m[7]!, m[6]!),
        fee: null,
        statedBalanceMinor: parseAmountToMinor(m[5]!, currency),
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

/** `Fees/VAT:SAR 1.12` — the same either-order rule as the amount. */
const FEE = /Fees\/VAT:\s*(?:([A-Za-z]{3})\s*([\d.,]+)|([\d.,]+)\s*([A-Za-z]{3}))/i;

/**
 * Every label that ends the field before it.
 *
 * `\b` before the group is load-bearing: without it, `At:` matches inside
 * `Fees/VAT:`, which comes FIRST in an international alert — so the merchant
 * was read as the VAT amount, "SAR 1.12". `Fees/VAT:` is listed ahead of the
 * group so it still ends a field at its own position.
 */
const LABELS =
  String.raw`Fees\/VAT:|\b(?:By|Card|Via|Amount|Date|At|To|From|Country|Service):`;

/** Both written forms: `20-10-2026` and `2026-10-20`. */
const DMY = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/;
const YMD = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;

/**
 * The date the message states, or null when it states none.
 *
 * An international purchase carries no date; the caller files it on the day it
 * arrived. Both orders are tried rather than one being assumed, because the
 * same bank writes `4-10-2026` on a purchase and `2026-10-22` on a 3-D Secure
 * code — and read with the wrong rule, 2026-10-22 becomes day 2026.
 */
function statedDate(text: string): string | null {
  const ymd = YMD.exec(text);
  if (ymd) return iso(ymd[1]!, ymd[2]!, ymd[3]!);
  const dmy = DMY.exec(text);
  if (dmy) return iso(dmy[3]!, dmy[2]!, dmy[1]!);
  return null;
}

const FIELD_END = new RegExp(
  String.raw`\s*(?:\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{4}-\d{1,2}-\d{1,2}|${LABELS})|\s*$`,
  'i',
);

function labelled(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const value = valueAfter(text, new RegExp(`\\b${label}:\\s*`, 'i'));
    if (value) return value;
  }
  return null;
}

/**
 * Whatever follows `start`, up to where the next field begins.
 *
 * Shared with `labelled` rather than written twice, because the destination on
 * a top up needs exactly the same rule and got it wrong on its own: anchored
 * on the end of the line it read correctly multi-line and then swallowed
 * "urpay Amount:200 SAR Via:0115 - Visa 27-9-2026 11:53" whole once the phone
 * flattened the message.
 */
function valueAfter(text: string, start: RegExp): string | null {
  const match = start.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const end = FIELD_END.exec(rest);
  return clean(end && end.index > 0 ? rest.slice(0, end.index) : rest) || null;
}

/** Trailing punctuation and collapsed whitespace; the name is otherwise kept. */
function clean(merchant: string): string {
  // Trailing asterisks come from the terminal padding a fixed-width field —
  // "CONTABO*.." is Contabo. Leading and inner ones are kept, because "UBR* PEN"
  // is how that merchant is actually spelled.
  return merchant
    .replace(/\s+/g, ' ')
    .replace(/[.,;*]+$/, '')
    .trim();
}

function iso(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
