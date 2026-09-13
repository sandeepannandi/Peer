import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../../src/webhook/verify.js';

const SECRET = 'webhook-secret';
const BODY = '{"action":"opened"}';

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature(SECRET, BODY, sign(SECRET, BODY))).toBe(true);
  });

  it('rejects a signature with the wrong secret', () => {
    expect(verifySignature(SECRET, BODY, sign('other-secret', BODY))).toBe(false);
  });

  it('rejects a signature over a tampered body', () => {
    expect(verifySignature(SECRET, `${BODY}x`, sign(SECRET, BODY))).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false);
  });
});
