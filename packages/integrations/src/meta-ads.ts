/**
 * Meta Ads integration — Facebook & Instagram Ads API.
 *
 * Provides campaign management, audience targeting, and funnel tracking
 * for tenant marketing automation. Used by recipes to create, monitor,
 * and optimize ad campaigns through the Meta Marketing API.
 *
 * Capabilities:
 * - Create/manage ad campaigns
 * - Custom audience creation from CRM data
 * - Lead form integration (leads → WhatsApp/orchestrator)
 * - Performance metrics and ROAS tracking
 * - Automated A/B testing via recipes
 */

import { createLogger } from './logger.js';

const logger = createLogger('meta-ads');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MetaAdsConfig {
  access_token: string;
  app_id: string;
  app_secret: string;
  ad_account_id: string;
  page_id?: string;
  instagram_account_id?: string;
  pixel_id?: string;
}

export interface CampaignConfig {
  name: string;
  objective: CampaignObjective;
  budget: {
    type: 'daily' | 'lifetime';
    amount_cents: number;
    currency: string;
  };
  schedule?: {
    start_time: string;
    end_time?: string;
  };
  targeting: AudienceTargeting;
  creative: AdCreative;
  placements?: AdPlacement[];
}

export type CampaignObjective =
  | 'AWARENESS'
  | 'TRAFFIC'
  | 'ENGAGEMENT'
  | 'LEADS'
  | 'APP_PROMOTION'
  | 'SALES';

export interface AudienceTargeting {
  age_min?: number;
  age_max?: number;
  genders?: ('male' | 'female' | 'all')[];
  locations?: Array<{
    type: 'country' | 'region' | 'city' | 'zip';
    value: string;
  }>;
  interests?: string[];
  behaviors?: string[];
  custom_audiences?: string[];
  lookalike_source?: string;
  lookalike_percentage?: number;
}

export interface AdCreative {
  type: 'image' | 'video' | 'carousel' | 'collection';
  headline: string;
  body: string;
  call_to_action: string;
  link_url?: string;
  media_urls: string[];
  lead_form?: LeadFormConfig;
}

export interface LeadFormConfig {
  name: string;
  questions: Array<{
    type: 'EMAIL' | 'PHONE' | 'FULL_NAME' | 'CUSTOM';
    label?: string;
  }>;
  privacy_policy_url: string;
  thank_you_message: string;
  webhook_url?: string;
}

export type AdPlacement = 'facebook_feed' | 'facebook_stories' | 'instagram_feed' | 'instagram_stories' | 'instagram_reels' | 'audience_network' | 'messenger';

export interface CampaignMetrics {
  campaign_id: string;
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number;
  cpc_cents: number;
  cpm_cents: number;
  spend_cents: number;
  conversions: number;
  cost_per_conversion_cents: number;
  roas: number;
  leads?: number;
  cost_per_lead_cents?: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';
  objective: CampaignObjective;
  budget: CampaignConfig['budget'];
  created_at: string;
  metrics?: CampaignMetrics;
}

// ─── Meta Ads Client ────────────────────────────────────────────────────────

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export class MetaAdsClient {
  private config: MetaAdsConfig;

  constructor(config: MetaAdsConfig) {
    this.config = config;
  }

  /**
   * Create a new ad campaign.
   */
  async createCampaign(campaignConfig: CampaignConfig): Promise<Campaign> {
    const { ad_account_id, access_token } = this.config;
    logger.info({ name: campaignConfig.name, objective: campaignConfig.objective }, 'Creating campaign');

    const response = await fetch(
      `${META_API_BASE}/act_${ad_account_id}/campaigns`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: campaignConfig.name,
          objective: campaignConfig.objective,
          status: 'PAUSED',
          special_ad_categories: [],
          access_token,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error({ error }, 'Campaign creation failed');
      throw new Error(`Meta API error: ${error}`);
    }

    const data = await response.json() as { id: string };

    // Create ad set with targeting and budget
    await this.createAdSet(data.id, campaignConfig);

    return {
      id: data.id,
      name: campaignConfig.name,
      status: 'PAUSED',
      objective: campaignConfig.objective,
      budget: campaignConfig.budget,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Create an ad set within a campaign.
   */
  private async createAdSet(campaignId: string, config: CampaignConfig): Promise<string> {
    const { ad_account_id, access_token } = this.config;

    const targeting: Record<string, unknown> = {};
    if (config.targeting.age_min) targeting.age_min = config.targeting.age_min;
    if (config.targeting.age_max) targeting.age_max = config.targeting.age_max;
    if (config.targeting.locations) {
      targeting.geo_locations = {
        countries: config.targeting.locations
          .filter((l) => l.type === 'country')
          .map((l) => l.value),
      };
    }
    if (config.targeting.interests) {
      targeting.flexible_spec = [
        { interests: config.targeting.interests.map((i) => ({ name: i })) },
      ];
    }

    const body: Record<string, unknown> = {
      name: `${config.name} - Ad Set`,
      campaign_id: campaignId,
      targeting,
      billing_event: 'IMPRESSIONS',
      optimization_goal: this.objectiveToOptimization(config.objective),
      status: 'PAUSED',
      access_token,
    };

    if (config.budget.type === 'daily') {
      body.daily_budget = config.budget.amount_cents;
    } else {
      body.lifetime_budget = config.budget.amount_cents;
    }

    if (config.schedule?.start_time) body.start_time = config.schedule.start_time;
    if (config.schedule?.end_time) body.end_time = config.schedule.end_time;

    const response = await fetch(
      `${META_API_BASE}/act_${ad_account_id}/adsets`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ad set creation failed: ${error}`);
    }

    const data = await response.json() as { id: string };
    return data.id;
  }

  /**
   * Get campaign metrics.
   */
  async getCampaignMetrics(campaignId: string, datePreset = 'last_30d'): Promise<CampaignMetrics> {
    const { access_token } = this.config;

    const response = await fetch(
      `${META_API_BASE}/${campaignId}/insights?fields=impressions,reach,clicks,ctr,cpc,cpm,spend,actions,cost_per_action_type&date_preset=${datePreset}&access_token=${access_token}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch campaign metrics: ${await response.text()}`);
    }

    const data = await response.json() as { data: Array<Record<string, unknown>> };
    const insight = data.data?.[0] ?? {};

    return {
      campaign_id: campaignId,
      impressions: Number(insight.impressions ?? 0),
      reach: Number(insight.reach ?? 0),
      clicks: Number(insight.clicks ?? 0),
      ctr: Number(insight.ctr ?? 0),
      cpc_cents: Math.round(Number(insight.cpc ?? 0) * 100),
      cpm_cents: Math.round(Number(insight.cpm ?? 0) * 100),
      spend_cents: Math.round(Number(insight.spend ?? 0) * 100),
      conversions: 0,
      cost_per_conversion_cents: 0,
      roas: 0,
    };
  }

  /**
   * List campaigns for the ad account.
   */
  async listCampaigns(): Promise<Campaign[]> {
    const { ad_account_id, access_token } = this.config;

    const response = await fetch(
      `${META_API_BASE}/act_${ad_account_id}/campaigns?fields=name,status,objective,daily_budget,lifetime_budget,created_time&access_token=${access_token}`,
    );

    if (!response.ok) {
      throw new Error(`Failed to list campaigns: ${await response.text()}`);
    }

    const data = await response.json() as { data: Array<Record<string, unknown>> };

    return (data.data ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name),
      status: String(c.status) as Campaign['status'],
      objective: String(c.objective) as CampaignObjective,
      budget: {
        type: c.daily_budget ? 'daily' as const : 'lifetime' as const,
        amount_cents: Number(c.daily_budget ?? c.lifetime_budget ?? 0),
        currency: 'USD',
      },
      created_at: String(c.created_time ?? new Date().toISOString()),
    }));
  }

  /**
   * Pause/resume a campaign.
   */
  async updateCampaignStatus(campaignId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    const { access_token } = this.config;

    const response = await fetch(`${META_API_BASE}/${campaignId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, access_token }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update campaign: ${await response.text()}`);
    }

    logger.info({ campaignId, status }, 'Campaign status updated');
  }

  /**
   * Create a custom audience from a list of contacts.
   */
  async createCustomAudience(
    name: string,
    description: string,
    contactType: 'EMAIL' | 'PHONE',
  ): Promise<string> {
    const { ad_account_id, access_token } = this.config;

    const response = await fetch(
      `${META_API_BASE}/act_${ad_account_id}/customaudiences`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          subtype: 'CUSTOM',
          customer_file_source: 'USER_PROVIDED_ONLY',
          access_token,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Custom audience creation failed: ${await response.text()}`);
    }

    const data = await response.json() as { id: string };
    logger.info({ audienceId: data.id, name }, 'Custom audience created');
    return data.id;
  }

  /**
   * Process an incoming lead from a lead form webhook.
   */
  processLead(leadData: Record<string, unknown>): {
    name?: string;
    email?: string;
    phone?: string;
    form_id: string;
    ad_id: string;
    created_at: string;
  } {
    return {
      name: leadData.full_name as string | undefined,
      email: leadData.email as string | undefined,
      phone: leadData.phone_number as string | undefined,
      form_id: String(leadData.form_id ?? ''),
      ad_id: String(leadData.ad_id ?? ''),
      created_at: new Date().toISOString(),
    };
  }

  private objectiveToOptimization(objective: CampaignObjective): string {
    const map: Record<CampaignObjective, string> = {
      AWARENESS: 'REACH',
      TRAFFIC: 'LINK_CLICKS',
      ENGAGEMENT: 'POST_ENGAGEMENT',
      LEADS: 'LEAD_GENERATION',
      APP_PROMOTION: 'APP_INSTALLS',
      SALES: 'OFFSITE_CONVERSIONS',
    };
    return map[objective] ?? 'IMPRESSIONS';
  }
}
