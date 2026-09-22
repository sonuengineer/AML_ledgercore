import { BusinessRuleError } from '../../shared/errors/AppError';

/**
 * Password policy.
 *
 * The legacy `D002001` already had the policy fields -- `PwdChgForcedYN`,
 * `PwdChgPeriodDays`, `MinLiFreqForcedYN`, `PwdNegativesMod`, `MaxBadLiPerDay`
 * -- so the bank clearly intended one. Nothing enforced them. Phase 3 wired up
 * the failed-login counters; this file is the rest.
 *
 * The rules below follow NIST SP 800-63B rather than the older
 * "one uppercase, one digit, one symbol, rotate every 30 days" convention:
 *
 *   - Length is the dominant factor, so the minimum is 12 rather than 8.
 *   - No composition rules. They push people to "Password1!" and, worse, to
 *     writing it on the monitor. A longer passphrase beats a short mutated word.
 *   - Block passwords derived from the user's own identifiers, which is the
 *     first thing an insider attacker tries.
 *   - Block a small deny-list of obvious choices. In production this would be
 *     a breached-password corpus (k-anonymity range query against a local
 *     copy of a HIBP-style dataset -- never sending the password anywhere).
 *   - No forced periodic rotation. Forced rotation measurably produces
 *     predictable increments (Passw0rd1 -> Passw0rd2). Rotation is triggered
 *     by evidence of compromise instead, which is what `revokeAllForUser`
 *     with reason PASSWORD_CHANGED is for.
 *
 * Trade-off, stated honestly: a bank auditor may demand 90-day rotation and
 * composition rules regardless of the evidence. `MAX_PASSWORD_AGE_DAYS` is
 * left as a documented, unset knob so that conversation has an implementation
 * to point at rather than a rewrite.
 */

export const MIN_PASSWORD_LENGTH = 12;
/** bcrypt's 72-byte limit does not apply to scrypt, but a bound stops a 1 MB
 *  "password" from turning one request into a CPU-bound denial of service. */
export const MAX_PASSWORD_LENGTH = 200;

/** Unset by choice. See the note on forced rotation above. */
export const MAX_PASSWORD_AGE_DAYS: number | null = null;

const OBVIOUS = new Set([
  'password',
  'password123',
  'passw0rd',
  '123456789012',
  'qwertyuiop',
  'letmein12345',
  'administrator',
  'changeme2026',
  'ledgercore',
  'welcome12345',
]);

export interface PasswordSubject {
  staffCode: string;
  displayName: string;
  email?: string | null;
}

const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export const assertPasswordAcceptable = (password: string, subject: PasswordSubject): void => {
  const fail = (code: string, message: string): never => {
    // The code is specific so the UI can point at the right field; the message
    // is written for the person typing, not for a log.
    throw new BusinessRuleError(code, message, { minLength: MIN_PASSWORD_LENGTH });
  };

  if (password.length < MIN_PASSWORD_LENGTH) {
    fail('PASSWORD_TOO_SHORT', `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    fail('PASSWORD_TOO_LONG', `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  }

  const flat = normalise(password);

  if (OBVIOUS.has(flat)) {
    fail('PASSWORD_TOO_COMMON', 'That password is too common. Choose something less predictable.');
  }

  // A single repeated character, however long, has almost no entropy.
  if (/^(.)\1+$/.test(password)) {
    fail('PASSWORD_TOO_COMMON', 'That password is too predictable. Choose something less repetitive.');
  }

  const identifiers = [
    subject.staffCode,
    subject.email?.split('@')[0] ?? '',
    ...subject.displayName.split(/\s+/),
  ]
    .map(normalise)
    // Two-character fragments match almost anything; they would reject valid
    // passwords rather than catch weak ones.
    .filter((value) => value.length >= 3);

  if (identifiers.some((identifier) => flat.includes(identifier))) {
    fail(
      'PASSWORD_CONTAINS_IDENTITY',
      'Password must not contain your name, staff code or email.',
    );
  }
};

/** Only meaningful if MAX_PASSWORD_AGE_DAYS is turned on. */
export const isPasswordExpired = (passwordChangedAt: Date): boolean => {
  if (MAX_PASSWORD_AGE_DAYS === null) return false;
  const ageMs = Date.now() - passwordChangedAt.getTime();
  return ageMs > MAX_PASSWORD_AGE_DAYS * 24 * 60 * 60 * 1000;
};
