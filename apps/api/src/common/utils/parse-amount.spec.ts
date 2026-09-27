import { detectCurrency, parseAmountToMinor } from './parse-amount';

/**
 * The iOS Wallet automation sends display text, not a number, so these are the
 * shapes a phone actually produces — including the two that make the decimal
 * separator ambiguous without knowing the currency.
 */
describe('parseAmountToMinor', () => {
  it('reads a plain decimal', () => {
    expect(parseAmountToMinor('12.34', 'USD')).toBe(1234);
  });

  it('strips currency decoration', () => {
    expect(parseAmountToMinor('$12.34', 'USD')).toBe(1234);
    expect(parseAmountToMinor('  £3.50 ', 'GBP')).toBe(350);
    expect(parseAmountToMinor('USD 12.34', 'USD')).toBe(1234);
  });

  it('groups with a comma when the decimal point is a dot', () => {
    expect(parseAmountToMinor('1,234.56', 'USD')).toBe(123456);
  });

  it('groups with a dot when the decimal point is a comma', () => {
    expect(parseAmountToMinor('1.234,56', 'EUR')).toBe(123456);
  });

  it('treats three trailing digits as grouping in a two-decimal currency', () => {
    // "1,234" is a thousand dollars and change, never 1234 cents.
    expect(parseAmountToMinor('1,234', 'USD')).toBe(123400);
  });

  it('keeps three decimals for a currency that has them', () => {
    expect(parseAmountToMinor('0.500', 'KWD')).toBe(500);
    expect(parseAmountToMinor('12.345', 'JOD')).toBe(12345);
  });

  it('treats every separator as grouping in a zero-decimal currency', () => {
    // LBP has no subunit, so "150,000" is a hundred and fifty thousand pounds.
    expect(parseAmountToMinor('150,000', 'LBP')).toBe(150000);
    expect(parseAmountToMinor('1.500.000', 'LBP')).toBe(1500000);
    expect(parseAmountToMinor('5000', 'JPY')).toBe(5000);
  });

  it('accepts a number as well as text', () => {
    expect(parseAmountToMinor(12.34, 'USD')).toBe(1234);
    expect(parseAmountToMinor(150000, 'LBP')).toBe(150000);
  });

  it('refuses refunds rather than guessing the sign', () => {
    expect(() => parseAmountToMinor('-12.34', 'USD')).toThrow(/refund/i);
    expect(() => parseAmountToMinor('($12.34)', 'USD')).toThrow(/refund/i);
    expect(() => parseAmountToMinor(-5, 'USD')).toThrow(/refund/i);
  });

  it('refuses what it cannot read', () => {
    expect(() => parseAmountToMinor('', 'USD')).toThrow();
    expect(() => parseAmountToMinor('   ', 'USD')).toThrow();
    expect(() => parseAmountToMinor('no amount here', 'USD')).toThrow(/Could not read/);
    expect(() => parseAmountToMinor('0.00', 'USD')).toThrow(/zero/);
  });
});

describe('detectCurrency', () => {
  it('reads an explicit ISO code', () => {
    expect(detectCurrency('SAR 3.00')).toBe('SAR');
    expect(detectCurrency('3.00 sar')).toBe('SAR');
    expect(detectCurrency('USD 12.34')).toBe('USD');
  });

  it('reads an unambiguous symbol', () => {
    expect(detectCurrency('£3.50')).toBe('GBP');
    expect(detectCurrency('€12,00')).toBe('EUR');
    expect(detectCurrency('﷼3.00')).toBe('SAR');
  });

  it('refuses the dollar sign, which three currencies share', () => {
    // Guessing USD here is how an Australian tap becomes a US one.
    expect(detectCurrency('$12.34')).toBeNull();
  });

  it('returns null when nothing names a currency', () => {
    expect(detectCurrency('12.34')).toBeNull();
    expect(detectCurrency('')).toBeNull();
  });

  it('does not match a code buried inside a word', () => {
    expect(detectCurrency('SARDINE 3.00')).toBeNull();
  });
});
