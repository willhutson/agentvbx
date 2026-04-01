/**
 * Channel health routes.
 *
 * GET /health/channels — returns per-org/channel health status and alerts.
 * Protected by X-Admin-Secret header.
 */

import { Router, type Request, type Response } from 'express';
import { channelHealth } from '../services/channelHealth.js';
import { createLogger } from '../logger.js';

const logger = createLogger('health-routes');

const router = Router();

/**
 * GET /health/channels
 */
router.get('/channels', (req: Request, res: Response) => {
  const adminSecret = process.env.ADMIN_SECRET;
  if (adminSecret && req.headers['x-admin-secret'] !== adminSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const status = channelHealth.getStatus();
  const alerts = channelHealth.checkHealth();

  logger.info({ channelCount: status.length, alertCount: alerts.length }, 'Channel health check');

  res.json({
    timestamp: new Date().toISOString(),
    channelCount: status.length,
    alertCount: alerts.length,
    alerts,
    channels: status,
  });
});

export default router;
