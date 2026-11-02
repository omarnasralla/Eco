import { describe, expect, it } from 'vitest';
import { buildFlow, feeImpliedByCredit, type BalanceCheckpoint } from './balance-flow';

/** The four real alerts that prompted this, in minor units. */
const cp = (
  id: string,
  occurredOn: string,
  amountMinor: number,
  statedBalanceMinor: number,
  merchant = 'URPAYRIYADH SA',
): BalanceCheckpoint => ({
  id,
  cardLast4: '0115',
  currency: 'USD',
  amountMinor,
  direction: -1,
  statedBalanceMinor,
  merchant,
  occurredOn,
  recordedAt: `${occurredOn}T00:00:00.000Z`,
});

const REAL = [
  cp('a', '2026-10-23', 20201, 253345),
  cp('b', '2026-10-28', 20191, 232020),
  cp('c', '2026-10-31', 53845, 607108),
  cp('d', '2026-11-02', 240000, 365447, 'IBL ASHRAFIEHASHRAFIEHLB'),
];

describe('buildFlow', () => {
  it('reads the real chain exactly', () => {
    const [flow] = buildFlow(REAL);
    expect(flow!.steps.map((s) => [s.checkpoint.occurredOn, s.gapMinor, s.kind])).toEqual([
      // Nothing before it to subtract from.
      ['2026-10-23', null, 'UNKNOWN'],
      // 2533.45 - 201.91 = 2331.54, but the bank said 2320.20: an 11.34 fee.
      ['2026-10-28', -1134, 'FEE'],
      // The salary landed in this gap, so the residue is money arriving.
      ['2026-10-31', 428933, 'UNEXPLAINED_CREDIT'],
      // 6071.08 - 2400 = 3671.08, but the bank said 3654.47: a 16.61 fee.
      ['2026-11-02', -1661, 'FEE'],
    ]);
  });

  it('names the big credit the salary once the salary is known', () => {
    // 4,289.33 arrived against 4,300.00 expected: the salary, short by the fee
    // on the transfer that happened in the same blind gap.
    const [flow] = buildFlow(REAL, 430000);
    const step = flow!.steps.find((s) => s.checkpoint.occurredOn === '2026-10-31');
    expect(step!.kind).toBe('SALARY');
    expect(flow!.salaryMinor).toBe(428933);
    expect(flow!.salaryShortfallMinor).toBe(1067);
    expect(flow!.unexplainedCreditsMinor).toBe(0);
  });

  it('will not call a small credit the salary', () => {
    const small = [cp('p', '2026-10-01', 10000, 100000), cp('q', '2026-10-02', 10000, 120000)];
    const [flow] = buildFlow(small, 430000);
    expect(flow!.steps[1]!.kind).toBe('UNEXPLAINED_CREDIT');
    expect(flow!.salaryMinor).toBe(0);
    expect(flow!.salaryShortfallMinor).toBe(0);
  });

  it('leaves credits unnamed when no salary figure is given', () => {
    // Guessing "salary" without something to compare against would be a
    // confident invention.
    expect(buildFlow(REAL)[0]!.steps[2]!.kind).toBe('UNEXPLAINED_CREDIT');
    expect(buildFlow(REAL)[0]!.salaryShortfallMinor).toBe(0);
  });

  it('accepts a salary short by a plausible fee but not by a third', () => {
    const credit = (gap: number) => [
      cp('p', '2026-10-01', 0, 430000),
      cp('q', '2026-10-02', 0, 430000 + gap),
    ];
    expect(buildFlow(credit(387000), 430000)[0]!.steps[1]!.kind).toBe('SALARY');
    expect(buildFlow(credit(286000), 430000)[0]!.steps[1]!.kind).toBe('UNEXPLAINED_CREDIT');
  });

  it('totals what the alerts stated and what they did not', () => {
    const [flow] = buildFlow(REAL);
    expect(flow!.statedOutMinor).toBe(20201 + 20191 + 53845 + 240000);
    expect(flow!.feesMinor).toBe(1134 + 1661);
    expect(flow!.unexplainedCreditsMinor).toBe(428933);
    expect(flow!.unexplainedDebitsMinor).toBe(0);
    expect(flow!.closingBalanceMinor).toBe(365447);
    expect(flow!.closingOn).toBe('2026-11-02');
  });

  it('counts the steps it could not check, so a total is never read as complete', () => {
    expect(buildFlow(REAL)[0]!.blindSteps).toBe(1);
  });

  it('orders by date regardless of the order given', () => {
    const shuffled = [REAL[3]!, REAL[1]!, REAL[0]!, REAL[2]!];
    expect(buildFlow(shuffled)[0]!.steps.map((s) => s.checkpoint.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('breaks a tie on the same day by when it was recorded', () => {
    const first = { ...cp('x', '2026-11-03', 1000, 100000), recordedAt: '2026-11-03T08:00:00Z' };
    const second = { ...cp('y', '2026-11-03', 1000, 99000), recordedAt: '2026-11-03T09:00:00Z' };
    expect(buildFlow([second, first])[0]!.steps.map((s) => s.checkpoint.id)).toEqual(['x', 'y']);
  });

  it('keeps one chain per card and per currency', () => {
    const other = { ...cp('z', '2026-10-24', 5000, 10000), cardLast4: '0363' };
    const otherCurrency = { ...cp('w', '2026-10-24', 5000, 10000), currency: 'SAR' };
    const flows = buildFlow([...REAL, other, otherCurrency]);
    expect(flows).toHaveLength(3);
    // Comparing balances across a card or a currency would be nonsense, so
    // each chain's first step is blind rather than measured against another's.
    expect(flows.filter((f) => f.steps[0]!.kind === 'UNKNOWN')).toHaveLength(3);
  });

  it('calls a large shortfall a missing message, not a fee', () => {
    // A fee is small and roughly fixed. Filing a 300 shortfall as a "fee"
    // would be a confident wrong answer; the right response is to go looking.
    const big = [cp('p', '2026-10-01', 10000, 100000), cp('q', '2026-10-02', 10000, 60000)];
    expect(buildFlow(big)[0]!.steps[1]!.kind).toBe('MISSING_DEBIT');
    expect(buildFlow(big)[0]!.feesMinor).toBe(0);
    expect(buildFlow(big)[0]!.unexplainedDebitsMinor).toBe(30000);
  });

  it('calls a balance that lands exactly what it is', () => {
    const clean = [cp('p', '2026-10-01', 10000, 100000), cp('q', '2026-10-02', 10000, 90000)];
    expect(buildFlow(clean)[0]!.steps[1]!.kind).toBe('EXACT');
    expect(buildFlow(clean)[0]!.feesMinor).toBe(0);
  });

  it('adds a credit rather than subtracting it', () => {
    const credit: BalanceCheckpoint[] = [
      cp('p', '2026-10-01', 10000, 100000),
      { ...cp('q', '2026-10-02', 50000, 150000), direction: 1 },
    ];
    expect(buildFlow(credit)[0]!.steps[1]!.kind).toBe('EXACT');
    expect(buildFlow(credit)[0]!.statedOutMinor).toBe(10000);
  });

  it('returns nothing for nothing', () => {
    expect(buildFlow([])).toEqual([]);
  });
});

describe('feeImpliedByCredit', () => {
  it('separates the salary from the fee hiding behind it', () => {
    // 4,300.00 expected, 4,289.33 observed => the 31 Oct transfer cost 10.67.
    expect(feeImpliedByCredit(428933, 430000)).toBe(1067);
  });

  it('is zero when the whole credit is accounted for', () => {
    expect(feeImpliedByCredit(430000, 430000)).toBe(0);
  });
});
