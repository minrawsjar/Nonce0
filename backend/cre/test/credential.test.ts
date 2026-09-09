import assert from 'node:assert/strict';
import test from 'node:test';

import type { Address, Hex, UnixSeconds } from '@opaque/protocol-types';

import { checkCredential, issueCredential, type RecipientCredential } from '../credential.ts';

const secret = new TextEncoder().encode('policy-authority-key');
const alice = `0x${'aa'.repeat(20)}` as Address;
const bob = `0x${'bb'.repeat(20)}` as Address;
const VERSION = 'policy-v3';
const NOW = 1_760_000_000n as UnixSeconds;
const EXPIRES = (NOW + 3600n) as UnixSeconds;

const credentialFor = (recipient: Address, policyVersion = VERSION, expiresAt = EXPIRES) =>
  issueCredential({ recipient, policyVersion, expiresAt }, secret);

const check = (credential: RecipientCredential, recipient = alice, now = NOW) =>
  checkCredential({ recipient, credential, policyVersion: VERSION, now, secret });

test('a credential issued for this recipient approves the payment', () => {
  assert.deepEqual(check(credentialFor(alice)), { kind: 'APPROVED' });
});

test('a credential for someone else does not authorise this payment', () => {
  // The recipient comes from the DECRYPTED SPEND, never from the credential.
  // Reading it off the credential would let one issued for an allowed address
  // authorise a payment to any other.
  const outcome = check(credentialFor(bob));
  assert.equal(outcome.kind, 'DENIED');
  assert.match(outcome.kind === 'DENIED' ? outcome.reason : '', /different recipient/);
});

test('a credential cannot be carried across a policy version change', () => {
  assert.equal(check(credentialFor(alice, 'policy-v2')).kind, 'DENIED');
});

test('an expired credential is denied, which is the revocation window', () => {
  const credential = credentialFor(alice, VERSION, (NOW + 10n) as UnixSeconds);
  assert.equal(check(credential, alice, NOW).kind, 'APPROVED');
  assert.equal(check(credential, alice, (NOW + 10n) as UnixSeconds).kind, 'DENIED');
});

test('a forged tag is denied, and so is a mangled one', () => {
  const real = credentialFor(alice);
  assert.equal(check({ ...real, tag: `0x${'00'.repeat(32)}` as Hex }).kind, 'DENIED');
  assert.equal(check({ ...real, tag: '0xnothex' as Hex }).kind, 'DENIED');
  assert.equal(check({ ...real, tag: '0xaabb' as Hex }).kind, 'DENIED');
});

test('a credential minted under a different authority key is denied', () => {
  const other = issueCredential(
    { recipient: alice, policyVersion: VERSION, expiresAt: EXPIRES },
    new TextEncoder().encode('not-the-authority'),
  );
  assert.equal(check(other).kind, 'DENIED');
});

test('editing any signed field invalidates the credential', () => {
  const real = credentialFor(alice);
  const edits: RecipientCredential[] = [
    { ...real, recipient: bob },
    { ...real, policyVersion: 'policy-v9' },
    { ...real, expiresAt: (EXPIRES + 86_400n) as UnixSeconds },
  ];
  // Each is checked against ITS OWN claimed fields, so these fail on the MAC
  // rather than on the cheap comparisons above.
  for (const credential of edits) {
    assert.equal(
      checkCredential({
        recipient: credential.recipient,
        credential,
        policyVersion: credential.policyVersion,
        now: NOW,
        secret,
      }).kind,
      'DENIED',
    );
  }
});

test('a failure is an outcome, never a throw', () => {
  // The evaluator processes a batch. A throw here would abort the whole run
  // and strand every other intent in it.
  assert.doesNotThrow(() => check({ ...credentialFor(alice), tag: '0x' as Hex }));
  assert.doesNotThrow(() => check(credentialFor(bob)));
});

test('an issued credential needs a policy version', () => {
  assert.throws(() =>
    issueCredential({ recipient: alice, policyVersion: '', expiresAt: EXPIRES }, secret),
  );
});

test('a credential survives the wire, where expiresAt is a decimal string', () => {
  // A credential travels inside the sealed intent as JSON, and JSON.stringify
  // throws outright on a bigint. Encoding it as a decimal string is the same
  // convention encodeBigint uses everywhere else; getting this wrong breaks
  // every payment rather than some edge case.
  const credential = credentialFor(alice);
  const wire = JSON.stringify(credential, (_k, v) =>
    typeof v === 'bigint' ? v.toString(10) : v,
  );
  const parsed = JSON.parse(wire) as Record<string, string>;
  assert.equal(parsed['expiresAt'], EXPIRES.toString());
  assert.deepEqual(
    check({ ...credential, expiresAt: BigInt(parsed['expiresAt']!) as UnixSeconds }),
    { kind: 'APPROVED' },
  );
});
