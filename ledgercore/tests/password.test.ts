import { describe, expect, it } from 'vitest';
import { scryptHasher } from '../src/modules/identity/password.service';

describe('password hashing', () => {
  it('never stores the plaintext', async () => {
    const encoded = await scryptHasher.hash('ChangeMe#2026');
    expect(encoded).not.toContain('ChangeMe');
    // The legacy column was CHAR(16), which cannot hold a real hash at all.
    expect(encoded.length).toBeGreaterThan(60);
  });

  it('produces a different hash each time (unique salt)', async () => {
    const [a, b] = await Promise.all([scryptHasher.hash('same-password'), scryptHasher.hash('same-password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const encoded = await scryptHasher.hash('ChangeMe#2026');
    await expect(scryptHasher.verify('ChangeMe#2026', encoded)).resolves.toBe(true);
    await expect(scryptHasher.verify('ChangeMe#2025', encoded)).resolves.toBe(false);
  });

  it('is self-describing so parameters can be raised later', async () => {
    const encoded = await scryptHasher.hash('x-password-x');
    const [algo, n, r, p] = encoded.split('$');
    expect(algo).toBe('scrypt');
    expect(Number(n)).toBe(32768);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
  });

  it('flags a hash made with weaker parameters for rehash', () => {
    expect(scryptHasher.needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(scryptHasher.needsRehash('bcrypt$whatever')).toBe(true);
  });

  it('does not throw on a malformed stored hash, just fails to verify', async () => {
    await expect(scryptHasher.verify('anything', 'garbage')).resolves.toBe(false);
  });
});
