/**
 * Channel health heartbeat tracker.
 *
 * Records lastMessageAt per org per channel. Detects when a previously
 * active channel goes silent (>24h with >10 msgs/day average).
 *
 * In-memory — suitable for single-instance. Survives restarts via
 * natural re-population from incoming messages.
 */

import { createLogger } from '../logger.js';

const logger = createLogger('channel-health');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChannelHealthRecord {
  orgId: string;
  channel: string;
  lastMessageAt: Date;
  dailyCounts: number[];  // rolling 7-day window, index 0 = today
  totalToday: number;
}

export interface ChannelHealthAlert {
  orgId: string;
  channel: string;
  lastMessageAt: Date;
  silentHours: number;
  avgDailyCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ALERT_THRESHOLD_HOURS = 24;
const MIN_DAILY_COUNT_FOR_ALERT = 10;

// ─── State ──────────────────────────────────────────────────────────────────

const healthRecords = new Map<string, ChannelHealthRecord>();
let currentDay = new Date().toDateString();

// ─── Internals ──────────────────────────────────────────────────────────────

function healthKey(orgId: string, channel: string): string {
  return `${orgId}:${channel}`;
}

function maybeResetDayCounter(): void {
  const today = new Date().toDateString();
  if (today !== currentDay) {
    currentDay = today;
    for (const record of healthRecords.values()) {
      record.dailyCounts.unshift(record.totalToday);
      if (record.dailyCounts.length > 7) record.dailyCounts.pop();
      record.totalToday = 0;
    }
  }
}

function getAvgDailyCount(record: ChannelHealthRecord): number {
  const counts = [...record.dailyCounts, record.totalToday].filter(c => c > 0);
  if (counts.length === 0) return 0;
  return counts.reduce((a, b) => a + b, 0) / counts.length;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const channelHealth = {
  /**
   * Record that a message was received for an org on a channel.
   */
  recordMessage(orgId: string, channel: string): void {
    maybeResetDayCounter();
    const key = healthKey(orgId, channel);
    const existing = healthRecords.get(key);

    if (existing) {
      existing.lastMessageAt = new Date();
      existing.totalToday += 1;
    } else {
      healthRecords.set(key, {
        orgId,
        channel,
        lastMessageAt: new Date(),
        dailyCounts: [],
        totalToday: 1,
      });
    }
  },

  /**
   * Check for channels that have gone silent.
   */
  checkHealth(): ChannelHealthAlert[] {
    maybeResetDayCounter();
    const now = new Date();
    const alerts: ChannelHealthAlert[] = [];

    for (const record of healthRecords.values()) {
      const silentMs = now.getTime() - record.lastMessageAt.getTime();
      const silentHours = silentMs / (1000 * 60 * 60);
      const avgDailyCount = getAvgDailyCount(record);

      if (silentHours >= ALERT_THRESHOLD_HOURS && avgDailyCount >= MIN_DAILY_COUNT_FOR_ALERT) {
        alerts.push({
          orgId: record.orgId,
          channel: record.channel,
          lastMessageAt: record.lastMessageAt,
          silentHours: Math.round(silentHours * 10) / 10,
          avgDailyCount: Math.round(avgDailyCount),
        });
      }
    }

    if (alerts.length > 0) {
      logger.warn({ alertCount: alerts.length }, 'Silent channel alerts detected');
    }

    return alerts;
  },

  /**
   * Get full status of all tracked channels.
   */
  getStatus(): Array<ChannelHealthRecord & { avgDailyCount: number; silentHours: number }> {
    maybeResetDayCounter();
    const now = new Date();
    return Array.from(healthRecords.values()).map(record => ({
      ...record,
      avgDailyCount: Math.round(getAvgDailyCount(record)),
      silentHours: Math.round(
        (now.getTime() - record.lastMessageAt.getTime()) / (1000 * 60 * 60) * 10,
      ) / 10,
    }));
  },

  /** For testing. */
  reset(): void {
    healthRecords.clear();
  },
};
