import { createHmac, timingSafeEqual } from 'node:crypto';

/** Verify the X-Hub-Signature-256 header against the raw request body (PLAN 17). */
export function verifySignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
