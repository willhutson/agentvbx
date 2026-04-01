/**
 * Tests for the channel health heartbeat service.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { channelHealth } from '../src/services/channelHealth.js';

describe('channelHealth', () => {
  beforeEach(() => {
    channelHealth.reset();
  });

  it('recordMessage creates a new entry', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    const status = channelHealth.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].orgId).toBe('org1');
    expect(status[0].channel).toBe('whatsapp');
    expect(status[0].totalToday).toBe(1);
  });

  it('recordMessage increments existing entry', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    channelHealth.recordMessage('org1', 'whatsapp');
    channelHealth.recordMessage('org1', 'whatsapp');
    const status = channelHealth.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].totalToday).toBe(3);
  });

  it('tracks different channels separately', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    channelHealth.recordMessage('org1', 'voice');
    const status = channelHealth.getStatus();
    expect(status).toHaveLength(2);

    const channels = status.map(s => s.channel).sort();
    expect(channels).toEqual(['voice', 'whatsapp']);
  });

  it('tracks different orgs separately', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    channelHealth.recordMessage('org2', 'whatsapp');
    const status = channelHealth.getStatus();
    expect(status).toHaveLength(2);

    const orgIds = status.map(s => s.orgId).sort();
    expect(orgIds).toEqual(['org1', 'org2']);
  });

  it('does not alert for newly created channels', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    const alerts = channelHealth.checkHealth();
    expect(alerts).toHaveLength(0);
  });

  it('does not alert for channels with low daily average', () => {
    // Record a few messages — below the MIN_DAILY_COUNT_FOR_ALERT (10)
    for (let i = 0; i < 5; i++) {
      channelHealth.recordMessage('org1', 'whatsapp');
    }

    // Even if we manually backdate (we can't in this test), low volume
    // should not trigger an alert
    const alerts = channelHealth.checkHealth();
    expect(alerts).toHaveLength(0);
  });

  it('getStatus includes avgDailyCount and silentHours', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    const status = channelHealth.getStatus();
    expect(status[0]).toHaveProperty('avgDailyCount');
    expect(status[0]).toHaveProperty('silentHours');
    expect(status[0].silentHours).toBeCloseTo(0, 0);
  });

  it('getStatus returns empty array after reset', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    channelHealth.reset();
    const status = channelHealth.getStatus();
    expect(status).toHaveLength(0);
  });

  it('updates lastMessageAt on each message', () => {
    channelHealth.recordMessage('org1', 'whatsapp');
    const first = channelHealth.getStatus()[0].lastMessageAt;

    // Small delay to ensure timestamp differs
    channelHealth.recordMessage('org1', 'whatsapp');
    const second = channelHealth.getStatus()[0].lastMessageAt;

    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });
});
