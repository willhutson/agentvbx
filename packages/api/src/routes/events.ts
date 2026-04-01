/**
 * SSE event stream route for Mission Control.
 *
 * GET /api/v1/events/:orgId
 *
 * Streams real-time AgentEvent objects as Server-Sent Events.
 * Mission Control subscribes via EventSource to display live
 * activity on the operational canvas.
 *
 * Auth accepts:
 *   - X-Agent-Secret header (service-to-service)
 *   - Authorization: Bearer <token> header
 *   - ?token=<token> query param (browser EventSource can't set headers)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { eventStream, type AgentEvent } from '../services/eventStream.js';
import { createLogger } from '../logger.js';

const logger = createLogger('events-route');

const router = Router();

// ─── Auth Middleware ─────────────────────────────────────────────────────────

function authenticateSSE(req: Request, res: Response, next: NextFunction): void {
  const agentSecret = req.headers['x-agent-secret'] as string | undefined;
  const authHeader = req.headers.authorization;
  const tokenParam = req.query.token as string | undefined;

  const expectedSecret = process.env.AGENT_RUNTIME_SECRET;
  const apiKey = process.env.API_KEY;

  // No auth configured — allow (dev mode)
  if (!expectedSecret && !apiKey) {
    next();
    return;
  }

  // Service-to-service: X-Agent-Secret
  if (expectedSecret && agentSecret === expectedSecret) {
    next();
    return;
  }

  // Bearer token (header or query param for browser EventSource)
  const bearerToken = tokenParam ?? authHeader?.replace(/^Bearer\s+/i, '');
  if (bearerToken) {
    // Check against API key or agent secret
    if (
      (apiKey && bearerToken === apiKey) ||
      (expectedSecret && bearerToken === expectedSecret)
    ) {
      next();
      return;
    }
  }

  res.status(401).json({ error: 'Unauthorized' });
}

// ─── SSE Endpoint ───────────────────────────────────────────────────────────

router.get('/:orgId', authenticateSSE, (req: Request, res: Response) => {
  const orgId = req.params.orgId as string;

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // Disable nginx buffering
    'Access-Control-Allow-Origin': process.env.SPOKESTACK_CORE_URL ?? '*',
    'Access-Control-Allow-Credentials': 'true',
  });

  // Flush headers immediately so the client knows the stream is open
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ orgId, timestamp: new Date().toISOString() })}\n\n`);

  logger.info({ orgId, listeners: eventStream.listenerCount(orgId) + 1 }, 'SSE client connected');

  // Heartbeat to keep connection alive through proxies/load balancers
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30_000);

  // Subscribe to org events
  const unsubscribe = eventStream.subscribe(orgId, (event: AgentEvent) => {
    res.write(`event: agent_action\ndata: ${JSON.stringify(event)}\n\n`);
  });

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    logger.info({ orgId }, 'SSE client disconnected');
  });
});

export default router;
