import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken } from '../src/shared/token.js';

test('a signed identity round-trips and carries its subject', () => {
  const token = signToken({ sub: 'usr_abc123' }, 'secret-a');
  const result = verifyToken(token, 'secret-a');
  assert.equal(result.valid, true);
  assert.equal(result.claims.sub, 'usr_abc123');
});

test('a token signed with another secret is rejected', () => {
  const token = signToken({ sub: 'usr_abc123' }, 'secret-a');
  assert.deepEqual(verifyToken(token, 'secret-b'), { valid: false, reason: 'bad_signature' });
});

test('tampering with the subject invalidates the signature', () => {
  // The attack the signature exists to stop: claim to be someone else, and in
  // doing so get a fresh rate-limit bucket.
  const token = signToken({ sub: 'usr_alice' }, 'secret-a');
  const [header, , signature] = token.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'usr_bob', iat: 1 })).toString('base64url');
  const forged = `${header}.${forgedPayload}.${signature}`;
  assert.equal(verifyToken(forged, 'secret-a').valid, false);
});

test('a token declaring alg "none" is rejected rather than trusted', () => {
  // Algorithm confusion: honouring the token's own alg claim lets an attacker
  // turn off verification by asking for it.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'usr_admin' })).toString('base64url');
  assert.deepEqual(verifyToken(`${header}.${payload}.`, 'secret-a'), { valid: false, reason: 'bad_algorithm' });
});

test('an expired token is rejected', () => {
  // exp passed through the claims, since a negative ttl sets no expiry at all.
  const expired = signToken({ sub: 'usr_abc123', exp: Math.floor(Date.now() / 1000) - 60 }, 'secret-a');
  assert.deepEqual(verifyToken(expired, 'secret-a'), { valid: false, reason: 'expired' });

  const live = signToken({ sub: 'usr_abc123' }, 'secret-a', 3600);
  assert.equal(verifyToken(live, 'secret-a').valid, true, 'a live ttl still verifies');
});

test('malformed input is rejected without throwing', () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', null, undefined, 42]) {
    const result = verifyToken(bad, 'secret-a');
    assert.equal(result.valid, false, `${String(bad)} should not verify`);
  }
});

