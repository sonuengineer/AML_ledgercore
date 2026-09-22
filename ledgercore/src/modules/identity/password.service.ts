import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` resolves to crypto.scrypt's 3-argument overload, which drops the
// options object. Pin the 4-argument signature so N/r/p actually take effect --
// silently falling back to the defaults (N=16384) would halve the work factor.
const scrypt = promisify(
  scryptCallback as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: ScryptOptions,
    callback: (err: Error | null, derivedKey: Buffer) => void,
  ) => void,
);

/**
 * Password hashing.
 *
 * Phase 0 found the legacy storage: `D002002 (UserCode CHAR(16), Password
 * CHAR(16))`. A 16-character column cannot hold a bcrypt hash (60 chars) or an
 * argon2 encoded string, so the password is plaintext or reversible. The login
 * controller then wrote it to a log file in cleartext.
 *
 * Choice here: scrypt from Node's standard library.
 *
 *   Problem   Need a slow, memory-hard KDF for passwords.
 *   Options   argon2id (best-in-class, native module), bcrypt (ubiquitous,
 *             72-byte input limit, not memory-hard), scrypt (memory-hard, in
 *             the Node stdlib, zero dependencies).
 *   Chosen    scrypt, N=2^15, r=8, p=1.
 *   Why       Memory-hard like argon2id, and no native build step -- which
 *             matters because a native module that fails to compile on a
 *             developer's or CI's platform is a real delivery risk, and the
 *             security difference between well-parameterised scrypt and
 *             argon2id is small compared to the difference between either and
 *             what the legacy system does.
 *   Trade-off argon2id is the current OWASP first recommendation and has
 *             better resistance to some GPU/ASIC attacks. The `passwordAlgo`
 *             column and this interface exist so switching is a per-user
 *             rehash on next login, not a flag day. See `needsRehash`.
 *
 * Encoded format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`. Self-describing, so
 * raising the cost parameters later does not invalidate existing hashes.
 */

const ALGO = 'scrypt';
const N = 32_768; // 2^15 -- roughly 32 MB of memory per hash at r=8
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// Node's default maxmem (32 MB) is exactly at the boundary for these params.
const MAX_MEM = 128 * N * R * 2;

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, encoded: string): Promise<boolean>;
  needsRehash(encoded: string): boolean;
}

const derive = async (plain: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> =>
  scrypt(plain.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM });

export const scryptHasher: PasswordHasher = {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await derive(plain, salt, N, R, P);
    return [ALGO, N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
  },

  async verify(plain: string, encoded: string): Promise<boolean> {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== ALGO) return false;

    const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [string, string, string, string, string, string];
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const expected = Buffer.from(hashRaw, 'base64');
    const salt = Buffer.from(saltRaw, 'base64');
    if (expected.length !== KEY_LENGTH) return false;

    const actual = await derive(plain, salt, n, r, p);

    // Constant-time compare. A plain `===` leaks how many leading bytes matched
    // through response timing, which is a practical attack on a login endpoint.
    return timingSafeEqual(actual, expected);
  },

  /**
   * True when the stored hash used weaker parameters than we use today.
   * Phase 4 calls this on successful login and transparently upgrades the
   * stored hash -- which is also how a future move to argon2id happens.
   */
  needsRehash(encoded: string): boolean {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== ALGO) return true;
    return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
  },
};

/**
 * A verification that always costs roughly one real hash, used when the staff
 * code does not exist. Without it, a missing user returns in ~1ms and a real
 * user in ~80ms, which lets an attacker enumerate valid staff codes.
 */
const DUMMY_HASH_PROMISE = scryptHasher.hash('ledgercore-timing-equaliser');

export const equaliseTiming = async (): Promise<void> => {
  const dummy = await DUMMY_HASH_PROMISE;
  await scryptHasher.verify('not-the-password', dummy);
};
