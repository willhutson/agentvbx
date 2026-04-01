/**
 * Message history routes.
 *
 * GET /api/v1/messages/:orgId       — paginated message history
 * GET /api/v1/messages/:orgId/count — message count (last 7 days)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { MessageHistoryService } from '../services/messageHistory.js';
import { createLogger } from '../logger.js';

const logger = createLogger('messages-routes');

/**
 * Create messages router with injected history service.
 */
export function createMessagesRouter(
  historyService: MessageHistoryService,
): Router {
  const router = Router();

  // Auth middleware — checks API key or agent secret
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const apiKey = process.env.API_KEY;
    const agentSecret = process.env.AGENT_RUNTIME_SECRET;
    const authHeader = req.headers.authorization?.replace('Bearer ', '');
    const secretHeader = req.headers['x-agent-secret'] as string | undefined;

    const isValid =
      (apiKey && authHeader === apiKey) ||
      (agentSecret && (secretHeader === agentSecret || authHeader === agentSecret));

    if (!apiKey && !agentSecret) {
      // No auth configured — allow (dev mode)
      next();
      return;
    }

    if (!isValid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  /**
   * GET /api/v1/messages/:orgId
   * Query: ?limit=50&before=<unix_ms>
   */
  router.get('/:orgId', requireAuth, async (req: Request, res: Response) => {
    const { orgId } = req.params;
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
    const before = req.query.before ? parseInt(String(req.query.before), 10) : undefined;

    try {
      const messages = await historyService.getHistory(orgId, limit, before);
      const hasMore = messages.length === limit;

      res.json({
        messages,
        hasMore,
        cursor: hasMore && messages.length > 0
          ? new Date(messages[messages.length - 1].timestamp).getTime()
          : null,
      });
    } catch (err) {
      logger.error({ err, orgId }, 'Failed to fetch message history');
      res.status(500).json({ error: 'Failed to fetch message history' });
    }
  });

  /**
   * GET /api/v1/messages/:orgId/count
   */
  router.get('/:orgId/count', requireAuth, async (req: Request, res: Response) => {
    const { orgId } = req.params;
    try {
      const count = await historyService.getMessageCount(orgId);
      res.json({ orgId, count, windowDays: 7 });
    } catch (err) {
      logger.error({ err, orgId }, 'Failed to fetch message count');
      res.status(500).json({ error: 'Failed to fetch message count' });
    }
  });

  return router;
}
