/**
 * Google OAuth2 authentication flow.
 *
 * Handles OAuth2 authorization URL generation, token exchange,
 * and token refresh for Google Workspace APIs.
 */

import { createLogger } from '../logger.js';

const logger = createLogger('google-auth');

export interface GoogleOAuthConfig {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  scopes: string[];
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: string;
  token_type: string;
  scope: string;
}

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export class GoogleAuth {
  private config: GoogleOAuthConfig;
  private tokens?: GoogleTokens;

  constructor(config: GoogleOAuthConfig) {
    this.config = {
      ...config,
      scopes: config.scopes.length > 0 ? config.scopes : DEFAULT_SCOPES,
    };
  }

  /**
   * Generate the OAuth2 authorization URL.
   * User navigates to this URL to grant access.
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      client_id: this.config.client_id,
      redirect_uri: this.config.redirect_uri,
      response_type: 'code',
      scope: this.config.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });

    if (state) params.set('state', state);

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens.
   */
  async exchangeCode(code: string): Promise<GoogleTokens> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        redirect_uri: this.config.redirect_uri,
        grant_type: 'authorization_code',
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Google token exchange failed: ${error}`);
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
      scope: string;
    };

    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      scope: data.scope,
    };

    logger.info('Google OAuth tokens obtained');
    return this.tokens;
  }

  /**
   * Refresh an expired access token.
   */
  async refreshAccessToken(refreshToken?: string): Promise<GoogleTokens> {
    const token = refreshToken ?? this.tokens?.refresh_token;
    if (!token) throw new Error('No refresh token available');

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: token,
        client_id: this.config.client_id,
        client_secret: this.config.client_secret,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Google token refresh failed: ${error}`);
    }

    const data = await res.json() as {
      access_token: string;
      expires_in: number;
      token_type: string;
      scope: string;
    };

    this.tokens = {
      access_token: data.access_token,
      refresh_token: token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      token_type: data.token_type,
      scope: data.scope,
    };

    logger.info('Google OAuth token refreshed');
    return this.tokens;
  }

  /**
   * Get a valid access token, refreshing if necessary.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new Error('Not authenticated');

    if (new Date(this.tokens.expires_at) <= new Date()) {
      await this.refreshAccessToken();
    }

    return this.tokens!.access_token;
  }

  /**
   * Set tokens directly (e.g., from stored credentials).
   */
  setTokens(tokens: GoogleTokens): void {
    this.tokens = tokens;
  }

  /**
   * Check if we have valid tokens.
   */
  isAuthenticated(): boolean {
    return !!this.tokens?.access_token;
  }
}
