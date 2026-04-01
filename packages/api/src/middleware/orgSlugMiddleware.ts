/**
 * Org slug middleware — resolves :orgSlug param and attaches org config to request.
 *
 * Returns 404 if org not found, 403 if the requested channel is not active.
 */

import type { Request, Response, NextFunction } from 'express';
import type { OrgConfig } from '../services/orgResolver.js';
import { OrgResolver } from '../services/orgResolver.js';

// Augment Express Request with org context
declare global {
  namespace Express {
    interface Request {
      org?: OrgConfig;
    }
  }
}

/**
 * Create middleware that resolves an org slug and validates channel access.
 *
 * @param resolver - OrgResolver instance (shared across routes)
 * @param channel  - Channel name to validate (e.g., 'whatsapp', 'voice')
 */
export function orgSlugMiddleware(
  resolver: OrgResolver,
  channel: string,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const slug = req.params.orgSlug;
    if (!slug) {
      res.status(400).json({ error: 'Missing org slug' });
      return;
    }

    const org = await resolver.resolveBySlug(slug);
    if (!org) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    if (!org.active) {
      res.status(403).json({ error: 'Organization is inactive' });
      return;
    }

    if (!org.channels[channel]) {
      res.status(403).json({ error: `Channel '${channel}' is not active for this organization` });
      return;
    }

    req.org = org;
    next();
  };
}
