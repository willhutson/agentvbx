/**
 * Tests for the SpokeStack entity event webhook receiver and recipe resolver.
 */

import { describe, it, expect } from 'vitest';
import { resolveRecipe } from '../src/routes/webhooks/spokestack-events.js';

describe('resolveRecipe', () => {
  it('matches Project status_changed to COMPLETED', () => {
    const result = resolveRecipe('Project', 'status_changed', { toStatus: 'COMPLETED', fromStatus: 'IN_PROGRESS' });
    expect(result).toBe('project-completed-notification');
  });

  it('does not match Project status_changed to non-COMPLETED status', () => {
    const result = resolveRecipe('Project', 'status_changed', { toStatus: 'IN_PROGRESS', fromStatus: 'DRAFT' });
    expect(result).toBeNull();
  });

  it('matches Brief updated with assigneeId in changedFields', () => {
    const result = resolveRecipe('Brief', 'updated', { changedFields: ['assigneeId', 'title'] });
    expect(result).toBe('brief-assigned-notification');
  });

  it('does not match Brief updated without assigneeId change', () => {
    const result = resolveRecipe('Brief', 'updated', { changedFields: ['title', 'description'] });
    expect(result).toBeNull();
  });

  it('matches Client created', () => {
    const result = resolveRecipe('Client', 'created');
    expect(result).toBe('client-created-notification');
  });

  it('does not match Client updated', () => {
    const result = resolveRecipe('Client', 'updated');
    expect(result).toBeNull();
  });

  it('matches Order created', () => {
    const result = resolveRecipe('Order', 'created');
    expect(result).toBe('order-created-notification');
  });

  it('matches Integration sync_completed', () => {
    const result = resolveRecipe('Integration', 'sync_completed');
    expect(result).toBe('integration-sync-notification');
  });

  it('returns null for unknown entity type', () => {
    const result = resolveRecipe('Unknown', 'created');
    expect(result).toBeNull();
  });

  it('returns null for unknown action', () => {
    const result = resolveRecipe('Project', 'unknown_action');
    expect(result).toBeNull();
  });

  it('handles missing metadata gracefully', () => {
    const result = resolveRecipe('Project', 'status_changed');
    expect(result).toBeNull();
  });

  it('handles Brief updated with non-array changedFields', () => {
    const result = resolveRecipe('Brief', 'updated', { changedFields: 'assigneeId' });
    expect(result).toBeNull(); // changedFields must be an array
  });
});
