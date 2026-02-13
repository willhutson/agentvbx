/**
 * White-label configuration manager.
 *
 * Allows tenants on business/agency tiers to fully customize the platform
 * branding: logos, colors, fonts, domain, email templates, and more.
 *
 * The desktop app and PWA read this config on startup to apply branding.
 */

import { createLogger } from '../logger.js';

const logger = createLogger('whitelabel');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WhitelabelConfig {
  tenant_id: string;
  enabled: boolean;

  brand: {
    name: string;
    tagline?: string;
    logo_url?: string;
    logo_dark_url?: string;
    favicon_url?: string;
  };

  theme: {
    primary_color: string;
    secondary_color: string;
    accent_color: string;
    background: string;
    surface: string;
    text_color: string;
    font_family?: string;
    border_radius?: string;
  };

  domain?: {
    custom_domain?: string;
    subdomain?: string;
  };

  email?: {
    from_name?: string;
    from_address?: string;
    reply_to?: string;
    footer_text?: string;
  };

  features?: {
    show_powered_by: boolean;
    custom_login_page: boolean;
    custom_onboarding: boolean;
    hide_agentvbx_branding: boolean;
  };

  created_at: string;
  updated_at: string;
}

const DEFAULT_THEME = {
  primary_color: '#6c7aff',
  secondary_color: '#4ade80',
  accent_color: '#facc15',
  background: '#0a0a0a',
  surface: '#111111',
  text_color: '#e0e0e0',
};

// ─── White-label Manager ────────────────────────────────────────────────────

export class WhitelabelManager {
  private configs: Map<string, WhitelabelConfig> = new Map();

  /**
   * Get white-label config for a tenant.
   */
  get(tenantId: string): WhitelabelConfig | undefined {
    return this.configs.get(tenantId);
  }

  /**
   * Set or update white-label config.
   */
  set(tenantId: string, config: Partial<WhitelabelConfig>): WhitelabelConfig {
    const existing = this.configs.get(tenantId);
    const now = new Date().toISOString();

    const merged: WhitelabelConfig = {
      tenant_id: tenantId,
      enabled: config.enabled ?? existing?.enabled ?? true,
      brand: {
        name: config.brand?.name ?? existing?.brand?.name ?? 'AGENTVBX',
        tagline: config.brand?.tagline ?? existing?.brand?.tagline,
        logo_url: config.brand?.logo_url ?? existing?.brand?.logo_url,
        logo_dark_url: config.brand?.logo_dark_url ?? existing?.brand?.logo_dark_url,
        favicon_url: config.brand?.favicon_url ?? existing?.brand?.favicon_url,
      },
      theme: {
        ...DEFAULT_THEME,
        ...existing?.theme,
        ...config.theme,
      },
      domain: config.domain ?? existing?.domain,
      email: config.email ?? existing?.email,
      features: {
        show_powered_by: config.features?.show_powered_by ?? existing?.features?.show_powered_by ?? true,
        custom_login_page: config.features?.custom_login_page ?? existing?.features?.custom_login_page ?? false,
        custom_onboarding: config.features?.custom_onboarding ?? existing?.features?.custom_onboarding ?? false,
        hide_agentvbx_branding: config.features?.hide_agentvbx_branding ?? existing?.features?.hide_agentvbx_branding ?? false,
      },
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.configs.set(tenantId, merged);
    logger.info({ tenantId, brand: merged.brand.name }, 'White-label config updated');
    return merged;
  }

  /**
   * Generate CSS variables from a white-label config.
   */
  toCSSVariables(tenantId: string): string {
    const config = this.configs.get(tenantId);
    if (!config) return '';

    return `:root {
  --wl-primary: ${config.theme.primary_color};
  --wl-secondary: ${config.theme.secondary_color};
  --wl-accent: ${config.theme.accent_color};
  --wl-bg: ${config.theme.background};
  --wl-surface: ${config.theme.surface};
  --wl-text: ${config.theme.text_color};
  ${config.theme.font_family ? `--wl-font: ${config.theme.font_family};` : ''}
  ${config.theme.border_radius ? `--wl-radius: ${config.theme.border_radius};` : ''}
}`;
  }

  /**
   * Delete white-label config.
   */
  delete(tenantId: string): boolean {
    return this.configs.delete(tenantId);
  }

  /**
   * List all tenants with white-label enabled.
   */
  listEnabled(): string[] {
    return Array.from(this.configs.entries())
      .filter(([, config]) => config.enabled)
      .map(([id]) => id);
  }
}
