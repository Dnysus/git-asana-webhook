/**
 * GitHub webhook signature verification (X-Hub-Signature-256).
 * See https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies the HMAC-SHA256 signature GitHub attaches to every delivery.
 * The comparison is constant-time to avoid leaking information via timing.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader?.startsWith('sha256=')) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
    'utf8',
  );
  const received = Buffer.from(signatureHeader, 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
