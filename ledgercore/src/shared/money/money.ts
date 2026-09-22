import Decimal from 'decimal.js';

/**
 * Money.
 *
 * This file exists because of one line in the legacy schema:
 *
 *     FcyTrnAmt   FLOAT   NOT NULL
 *
 * IEEE-754 doubles cannot represent 0.01 exactly. In a ledger that is not a
 * rounding nuisance, it is a correctness bug: vouchers stop balancing and
 * balances drift. See PHASE0_DOMAIN_ANALYSIS.md A8.3.
 *
 * The rules here:
 *
 *  1. Storage is `NUMERIC(19,4)` in Postgres. Exact decimal, four places.
 *  2. Transport and in-memory representation is a STRING, branded as `Money`.
 *     `node-postgres` returns NUMERIC as a string by default and that default
 *     is never overridden. A `number` never touches a monetary value.
 *  3. Arithmetic goes through decimal.js. Never `+`, never `*`.
 *  4. Four decimal places internally so interest and tax intermediates do not
 *     lose precision. Rounding to 2 (paisa) happens once, at the posting
 *     boundary, via `toPosting`.
 *
 * The branded type makes rule 2 a compile-time guarantee rather than a
 * convention people remember on a good day.
 */

declare const moneyBrand: unique symbol;
export type Money = string & { readonly [moneyBrand]: 'Money' };

/** Internal working scale. Wider than the posting scale on purpose. */
export const WORKING_SCALE = 4;
/** Scale money is actually posted and reported at (paisa). */
export const POSTING_SCALE = 2;

// Banker's rounding would silently change totals people reconcile by hand.
// Half-up matches how the bank's existing reports and the legacy IntRoffOpt
// behave, so it is the least surprising choice.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export class MoneyError extends Error {}

const DECIMAL_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

const toDecimal = (value: Money | string): Decimal => new Decimal(value);

/**
 * The only way to construct a Money.
 *
 * Accepts a string (from the DB, or from a validated request body). Accepts a
 * `number` ONLY for literals in tests and seeds, and rejects anything that is
 * not safely representable -- an escape hatch that cannot be abused silently.
 */
export const money = (value: string | number): Money => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`Not a finite number: ${value}`);
    if (!Number.isSafeInteger(value * 100)) {
      throw new MoneyError(
        `Refusing to build Money from the float ${value}: it is not exactly representable. Pass a string.`,
      );
    }
    return money(value.toFixed(POSTING_SCALE));
  }

  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new MoneyError(`Not a valid monetary amount: "${value}"`);
  }
  return new Decimal(trimmed).toFixed(WORKING_SCALE) as Money;
};

export const ZERO: Money = money('0');

export const add = (a: Money, b: Money): Money =>
  toDecimal(a).plus(toDecimal(b)).toFixed(WORKING_SCALE) as Money;

export const subtract = (a: Money, b: Money): Money =>
  toDecimal(a).minus(toDecimal(b)).toFixed(WORKING_SCALE) as Money;

/** Money times a plain ratio (an interest rate, a share). Never money x money. */
export const multiply = (a: Money, factor: string | number): Money =>
  toDecimal(a).times(new Decimal(factor)).toFixed(WORKING_SCALE) as Money;

export const negate = (a: Money): Money => toDecimal(a).negated().toFixed(WORKING_SCALE) as Money;

export const abs = (a: Money): Money => toDecimal(a).abs().toFixed(WORKING_SCALE) as Money;

export const sum = (values: readonly Money[]): Money =>
  values.reduce<Money>((acc, value) => add(acc, value), ZERO);

/** -1, 0 or 1. Use this instead of `<` on the strings. */
export const compare = (a: Money, b: Money): -1 | 0 | 1 =>
  toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1;

export const equals = (a: Money, b: Money): boolean => compare(a, b) === 0;
export const isZero = (a: Money): boolean => toDecimal(a).isZero();
export const isPositive = (a: Money): boolean => toDecimal(a).greaterThan(0);
export const isNegative = (a: Money): boolean => toDecimal(a).lessThan(0);
export const greaterThan = (a: Money, b: Money): boolean => compare(a, b) === 1;
export const greaterThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) >= 0;
export const lessThan = (a: Money, b: Money): boolean => compare(a, b) === -1;

/**
 * Round to the posting scale. Called exactly once per amount, at the boundary
 * where a computed figure becomes a ledger entry.
 */
export const toPosting = (a: Money): Money =>
  toDecimal(a).toDecimalPlaces(POSTING_SCALE, Decimal.ROUND_HALF_UP).toFixed(WORKING_SCALE) as Money;

/** For display and for the API envelope: "1234.50". */
export const format = (a: Money): string => toDecimal(a).toFixed(POSTING_SCALE);

/**
 * Minor units (paisa) as a bigint, for anything that needs an integer --
 * checksums, file exports to regulators, external payment rails.
 */
export const toMinorUnits = (a: Money): bigint =>
  BigInt(toDecimal(a).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));

/**
 * A zod-compatible parser, so request bodies produce Money directly instead of
 * a string that someone later forgets to convert.
 */
export const parseMoney = (value: unknown): Money => {
  if (typeof value === 'string' || typeof value === 'number') return money(value);
  throw new MoneyError(`Expected a monetary amount, received ${typeof value}`);
};
