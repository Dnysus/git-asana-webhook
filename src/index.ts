/**
 * HTTP entrypoint. Exposes:
 *   GET  /healthz  — liveness probe
 *   POST /webhook  — GitHub webhook receiver (HMAC signature-verified)
 *
 * Deliveries are processed synchronously before responding so the service
 * stays correct under Cloud Run's request-scoped CPU allocation (background
 * work after the response may be throttled). GitHub allows 10s per delivery,
 * which comfortably covers the couple of Asana calls made per event.
 */

import express from 'express';
import type { NextFunction, Request, Response } from 'express';

import { AsanaClient } from './asana/client.js';
import { loadConfig, type Config } from './config.js';
import { handleGithubEvent } from './handlers/github.js';
import { logger } from './utils/logger.js';
import { verifyGithubSignature } from './utils/verifySignature.js';

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const asana = new AsanaClient({
  accessToken: config.asana.accessToken,
  workspaceGid: config.asana.workspaceGid,
});

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

// The raw body is required to verify the HMAC signature before parsing.
app.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '5mb' }),
  async (req: Request, res: Response) => {
    const deliveryId = req.get('x-github-delivery') ?? 'unknown';

    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: 'expected an application/json body' });
      return;
    }

    if (!verifyGithubSignature(config.githubWebhookSecret, req.body, req.get('x-hub-signature-256'))) {
      logger.warn('Rejected delivery with missing or invalid signature', { deliveryId });
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    const eventName = req.get('x-github-event');
    if (!eventName) {
      res.status(400).json({ error: 'missing X-GitHub-Event header' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'payload is not valid JSON' });
      return;
    }

    const result = await handleGithubEvent(eventName, payload, { asana, config });
    logger.info('Delivery handled', { deliveryId, event: eventName, ...result });
    res.status(200).json(result);
  },
);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});

// Express 5 forwards rejected async handlers here automatically.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error while processing request', {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  res.status(500).json({ error: 'internal server error' });
});

const server = app.listen(config.port, () => {
  logger.info('git-asana-webhook listening', { port: config.port });
});

// Cloud Run (and most orchestrators) send SIGTERM before instance shutdown.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, draining connections');
  server.close(() => {
    process.exit(0);
  });
});
