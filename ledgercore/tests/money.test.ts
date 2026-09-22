import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  equals,
  format,
  money,
  MoneyError,
  multiply,
  subtract,
  sum,
  toMinorUnits,
  toPosting,
  ZERO,
} from '../src/shared/money/money';

/**
 * These tests exist to pin down the one defect that would make the whole
 * ledger wrong. They are not ceremony -- each case below is a behaviour the
 * legacy FLOAT columns get wrong.
 */

describe('Money', () => {
  it('adds decimals exactly, where a float would not', () => {
    // The canonical float failure: 0.1 + 0.2 === 0.30000000000000004
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(format(add(money('0.10'), money('0.20')))).toBe('0.30');
  });

  it('keeps a long chain of paisa additions exact', () => {
    // 1000 x 0.01 as floats drifts. As Money it must land on exactly 10.00.
    const total = Array.from({ length: 1000 }, () => money('0.01')).reduce(add, ZERO);
    expect(format(total)).toBe('10.00');
  });

  it('subtracts without drift', () => {
    expect(format(subtract(money('100.00'), money('99.99')))).toBe('0.01');
  });

  it('balances a voucher: sum(Dr) must equal sum(Cr)', () => {
    const debits = [money('1500.50'), money('249.50')];
    const credits = [money('1750.00')];
    expect(equals(sum(debits), sum(credits))).toBe(true);
  });

  it('keeps 4 decimal places internally for interest intermediates', () => {
    // 7.35% of 1234.56 = 90.73... -- the fraction of a paisa must survive
    // until the posting boundary, not be rounded at each step.
    const interest = multiply(money('1234.56'), '0.0735');
    expect(interest).toBe('90.7402');
    expect(format(toPosting(interest))).toBe('90.74');
  });

  it('rounds half-up at the posting boundary', () => {
    expect(format(toPosting(money('10.005')))).toBe('10.01');
    expect(format(toPosting(money('10.004')))).toBe('10.00');
  });

  it('refuses a float literal that is not exactly representable', () => {
    expect(() => money(0.1 + 0.2)).toThrow(MoneyError);
  });

  it('accepts safe numeric literals for seeds and tests', () => {
    expect(format(money(1500.5))).toBe('1500.50');
  });

  it('rejects junk instead of silently producing NaN', () => {
    expect(() => money('abc')).toThrow(MoneyError);
    expect(() => money('')).toThrow(MoneyError);
    expect(() => money('1e10')).toThrow(MoneyError);
  });

  it('compares without relying on string ordering', () => {
    // Lexicographically "9.00" > "10.00". Numerically it is not.
    expect(compare(money('9.00'), money('10.00'))).toBe(-1);
  });

  it('converts to minor units for regulatory file exports', () => {
    expect(toMinorUnits(money('1234.56'))).toBe(123456n);
    expect(toMinorUnits(money('0.005'))).toBe(1n);
  });
});
