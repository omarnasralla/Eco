/**
 * What a bank's balance alerts add up to.
 *
 * Each alert states a movement and the balance left after it. On its own that
 * is just a receipt. Chained in order it is an audit: subtract the movement
 * from the previous balance and the answer should be the next balance, and
 * wherever it is not, money moved that no message mentioned.
 *
 * That residue is the whole point. A bank never states its transfer fee, and
 * a fee is exactly a withdrawal nobody told you about.
 */

/** One alert, as recorded. */
export interface BalanceCheckpoint {
  id: string;
  cardLast4: string;
  currency: string;
  /** Always positive; `direction` carries the sign. */
  amountMinor: number;
  /** -1 left the account, +1 arrived. */
  direction: number;
  /** The balance after the movement, exactly as the bank stated it. */
  statedBalanceMinor: number;
  merchant: string;
  /** YYYY-MM-DD. */
  occurredOn: string;
  /** Tie-breaker for two movements on one day. */
  recordedAt: string;
}

/**
 * What the residue between two consecutive checkpoints means.
 *
 * `FEE` and `MISSING_DEBIT` are the same arithmetic — money left that was not
 * announced — separated only by size, because the useful question is not what
 * the number is but whether to go looking for a message. A plausible fee is
 * filed; a large one is a gap in the record.
 */
export type GapKind =
  | 'EXACT'
  | 'FEE'
  | 'MISSING_DEBIT'
  | 'SALARY'
  | 'UNEXPLAINED_CREDIT'
  | 'UNKNOWN';

export interface FlowStep {
  checkpoint: BalanceCheckpoint;
  /** The balance this step started from, or null for the first in a chain. */
  openingBalanceMinor: number | null;
  /** opening − amount: what the balance should have become. */
  expectedBalanceMinor: number | null;
  /**
   * stated − expected. Negative means more left than was announced, positive
   * means money arrived with no alert to explain it. Null for the first step,
   * which has nothing to be compared against.
   */
  gapMinor: number | null;
  kind: GapKind;
}

export interface FlowSummary {
  cardLast4: string;
  currency: string;
  steps: FlowStep[];
  /** Movements the alerts did announce, added up. */
  statedOutMinor: number;
  /** Fees proven by the arithmetic — the gaps small enough to be charges. */
  feesMinor: number;
  /** Debits large enough that a missing message is the likelier explanation. */
  unexplainedDebitsMinor: number;
  /** Credits big enough to be the monthly salary arriving. */
  salaryMinor: number;
  /**
   * What those salary credits were short by.
   *
   * A salary landing in the same blind gap as a transfer leaves one number
   * covering both, so the transfer's fee is invisible — until the expected
   * salary is known, and then it is exactly the shortfall. This is what turned
   * "about 4,289 arrived" into "the salary is 4,300 and that transfer cost
   * 10.67". Zero when no salary figure was supplied.
   */
  salaryShortfallMinor: number;
  /** Money that arrived unannounced and was too small to be the salary. */
  unexplainedCreditsMinor: number;
  /** The most recent balance the bank stated, and when. */
  closingBalanceMinor: number | null;
  closingOn: string | null;
  /** Steps whose gap could not be computed, so the totals are incomplete. */
  blindSteps: number;
}

/**
 * Above this, a shortfall is reported as a missing debit rather than a fee.
 *
 * A transfer fee is a small, roughly fixed charge. Calling a large shortfall a
 * "fee" would be a confident wrong answer, and the right response to one is to
 * go and find the message, not to file it as a cost.
 */
export const MAX_PLAUSIBLE_FEE_MINOR = 5_000;

/**
 * How close to the expected salary a credit must be to be called the salary.
 *
 * Not an exact match, and it never can be: the salary lands in the same blind
 * gap as whatever transfer happened beside it, so the credit is always the
 * salary minus that transfer's fee. 90% leaves room for a fee without letting
 * an unrelated few hundred be mistaken for a month's pay.
 */
export const SALARY_MATCH_FRACTION = 0.9;

/**
 * Order checkpoints and read the gaps between them.
 *
 * One chain per card and currency: two cards share no balance, and neither do
 * two currencies on one card, so comparing across either produces nonsense.
 */
export function buildFlow(
  checkpoints: BalanceCheckpoint[],
  /**
   * The monthly salary expected in this chain's currency, when one is known.
   *
   * Supplying it turns the largest credits from "money arrived from somewhere"
   * into "the salary landed, and it was short by this much" — which is the only
   * way the fee hiding behind a salary can be read at all.
   */
  expectedSalaryMinor?: number,
): FlowSummary[] {
  const chains = new Map<string, BalanceCheckpoint[]>();
  for (const c of checkpoints) {
    const key = `${c.cardLast4}|${c.currency}`;
    const chain = chains.get(key);
    if (chain) chain.push(c);
    else chains.set(key, [c]);
  }

  return [...chains.values()].map((chain) => {
    const ordered = [...chain].sort(
      (a, b) =>
        a.occurredOn.localeCompare(b.occurredOn) || a.recordedAt.localeCompare(b.recordedAt),
    );

    const steps: FlowStep[] = [];
    let previous: BalanceCheckpoint | null = null;
    for (const checkpoint of ordered) {
      const signed = checkpoint.direction < 0 ? -checkpoint.amountMinor : checkpoint.amountMinor;
      const opening = previous ? previous.statedBalanceMinor : null;
      const expected = opening === null ? null : opening + signed;
      const gap = expected === null ? null : checkpoint.statedBalanceMinor - expected;
      steps.push({
        checkpoint,
        openingBalanceMinor: opening,
        expectedBalanceMinor: expected,
        gapMinor: gap,
        kind: classify(gap, expectedSalaryMinor),
      });
      previous = checkpoint;
    }

    const last = ordered[ordered.length - 1];
    return {
      cardLast4: ordered[0]!.cardLast4,
      currency: ordered[0]!.currency,
      steps,
      statedOutMinor: ordered
        .filter((c) => c.direction < 0)
        .reduce((sum, c) => sum + c.amountMinor, 0),
      feesMinor: total(steps, 'FEE'),
      unexplainedDebitsMinor: total(steps, 'MISSING_DEBIT'),
      salaryMinor: total(steps, 'SALARY'),
      unexplainedCreditsMinor: total(steps, 'UNEXPLAINED_CREDIT'),
      // Each salary credit is short by whatever the transfer recorded beside
      // it cost. Added up rather than reported per step, because what is
      // useful is the total being lost to transfers this way.
      salaryShortfallMinor: expectedSalaryMinor
        ? steps
            .filter((s) => s.kind === 'SALARY')
            .reduce((sum, s) => sum + feeImpliedByCredit(s.gapMinor ?? 0, expectedSalaryMinor), 0)
        : 0,
      closingBalanceMinor: last ? last.statedBalanceMinor : null,
      closingOn: last ? last.occurredOn : null,
      blindSteps: steps.filter((s) => s.gapMinor === null).length,
    };
  });
}

function classify(gap: number | null, expectedSalaryMinor?: number): GapKind {
  if (gap === null) return 'UNKNOWN';
  if (gap === 0) return 'EXACT';
  if (gap > 0) {
    // A credit near the expected salary is the salary. On this account it is
    // the only thing that arrives at that size, and calling it "a refund or a
    // transfer" made the one predictable event in the chain look mysterious.
    const isSalary =
      expectedSalaryMinor !== undefined &&
      gap >= Math.round(expectedSalaryMinor * SALARY_MATCH_FRACTION);
    return isSalary ? 'SALARY' : 'UNEXPLAINED_CREDIT';
  }
  return -gap <= MAX_PLAUSIBLE_FEE_MINOR ? 'FEE' : 'MISSING_DEBIT';
}

/** Gaps of one kind, as a positive magnitude. */
function total(steps: FlowStep[], kind: GapKind): number {
  return steps
    .filter((s) => s.kind === kind)
    .reduce((sum, s) => sum + Math.abs(s.gapMinor ?? 0), 0);
}

/**
 * What a credit was, once something known is subtracted from it.
 *
 * An unexplained credit is a deposit minus whatever the fee on the movement
 * recorded beside it was — the two happen in the same blind gap and the
 * arithmetic cannot separate them. Given the deposit that was expected, the
 * remainder is that fee. This is what turned "about 4,289 arrived" into "the
 * salary was 4,300 and the transfer cost 10.67".
 */
export function feeImpliedByCredit(gapMinor: number, expectedCreditMinor: number): number {
  return expectedCreditMinor - gapMinor;
}
