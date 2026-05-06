import { describe, expect, it, vi } from 'vitest';
import {
  buildManualAdSetCreateInput,
  compactConvexWrite,
  getManualCombineErrorResponse,
  isMissingAtomicAdSetFunctionError,
  moveDeploymentsToPlanner,
  normalizeDeploymentIds,
  rollbackManualAdSetCombine,
  snapshotDeploymentAssignments,
} from '../services/adSetPlanner.js';

describe('manual ad set planning helpers', () => {
  it('builds a draft ad set payload without requiring angle_id', () => {
    const payload = buildManualAdSetCreateInput({
      adSetId: 'adset-1',
      projectId: 'project-1',
      campaignId: 'campaign-1',
      name: 'Manual Test',
      defaults: {
        meta_targeting: null,
        meta_budget_type: null,
        meta_budget_amount_cents: null,
        meta_schedule: null,
        meta_optimization_goal: null,
        meta_billing_event: null,
      },
    });

    expect(payload).toMatchObject({
      id: 'adset-1',
      project_id: 'project-1',
      campaign_id: 'campaign-1',
      name: 'Manual Test',
      sort_order: 0,
      lifecycle_status: 'draft',
    });
    expect(payload.angle_id).toBeUndefined();
    expect(payload.meta_targeting).toBeUndefined();
    expect(payload.meta_budget_type).toBeUndefined();
    expect(payload.meta_budget_amount_cents).toBeUndefined();
    expect(payload.meta_schedule).toBeUndefined();
    expect(payload.meta_optimization_goal).toBeUndefined();
    expect(payload.meta_billing_event).toBeUndefined();
  });

  it('preserves an explicit angle_id when one is provided', () => {
    const payload = buildManualAdSetCreateInput({
      adSetId: 'adset-1',
      projectId: 'project-1',
      campaignId: 'campaign-1',
      name: 'Director Test',
      angleId: ' angle-1 ',
    });

    expect(payload.angle_id).toBe('angle-1');
  });

  it('preserves valid Meta defaults while removing only nullish values', () => {
    const payload = buildManualAdSetCreateInput({
      adSetId: 'adset-1',
      projectId: 'project-1',
      campaignId: 'campaign-1',
      name: 'Manual Test',
      defaults: {
        meta_budget_type: 'daily',
        meta_budget_amount_cents: 5000,
        meta_billing_event: 'IMPRESSIONS',
        meta_optimization_goal: undefined,
      },
    });

    expect(payload.meta_budget_type).toBe('daily');
    expect(payload.meta_budget_amount_cents).toBe(5000);
    expect(payload.meta_billing_event).toBe('IMPRESSIONS');
    expect(payload.meta_optimization_goal).toBeUndefined();
  });

  it('compacts Convex write payloads without dropping falsey valid values', () => {
    expect(compactConvexWrite({
      empty: '',
      zero: 0,
      falseValue: false,
      nullValue: null,
      undefinedValue: undefined,
    })).toEqual({
      empty: '',
      zero: 0,
      falseValue: false,
    });
  });

  it('normalizes deployment ids and rejects duplicates before calling Convex', () => {
    expect(normalizeDeploymentIds([' dep-1 ', 'dep-2'])).toEqual({
      ids: ['dep-1', 'dep-2'],
      error: null,
    });

    expect(normalizeDeploymentIds(['dep-1', ' dep-1 ']).error)
      .toContain('duplicate ids: dep-1');
    expect(normalizeDeploymentIds(['dep-1', '']).error)
      .toContain('invalid values at index 1');
    expect(normalizeDeploymentIds([]).error)
      .toBe('deployment_ids must be a non-empty array');
  });

  it('maps missing Convex atomic combine functions to an operator action', () => {
    const err = new Error("[Request ID: abc] Server Error Could not find public function for 'adSets:createFromDeployments'. Did you forget to run `npx convex dev`?");

    expect(isMissingAtomicAdSetFunctionError(err)).toBe(true);
    expect(getManualCombineErrorResponse(err, { convexHost: 'impartial-shrimp-656.convex.cloud' })).toEqual({
      status: 503,
      message: 'Ad set creation is temporarily unavailable because the configured Convex deployment (impartial-shrimp-656.convex.cloud) is missing the atomic ad-set combine function. Please deploy Convex functions to the same deployment this site is using, then try again.',
    });
  });

  it('maps invalid deployment validation errors to clear 400 responses', () => {
    expect(getManualCombineErrorResponse(new Error('INVALID_DEPLOYMENTS: unknown: dep-1'))).toEqual({
      status: 400,
      message: 'Invalid deployment_ids: unknown: dep-1',
    });
  });

  it('snapshots original deployment assignments and reports unknown ids', () => {
    const result = snapshotDeploymentAssignments(['dep-1', 'dep-2'], [
      { externalId: 'dep-1', local_adset_id: 'old-adset', local_campaign_id: 'old-campaign' },
    ]);

    expect(result.missingIds).toEqual(['dep-2']);
    expect(result.snapshots.get('dep-1')).toEqual({
      local_adset_id: 'old-adset',
      local_campaign_id: 'old-campaign',
    });
  });

  it('restores updated deployments and deletes the newly-created ad set on rollback', async () => {
    const updateDeployment = vi.fn().mockResolvedValue(null);
    const deleteAdSet = vi.fn().mockResolvedValue(null);
    const logger = { warn: vi.fn() };
    const snapshots = new Map([
      ['dep-1', { local_adset_id: 'old-adset', local_campaign_id: 'old-campaign' }],
      ['dep-2', { local_adset_id: '', local_campaign_id: 'unplanned' }],
    ]);

    await rollbackManualAdSetCombine({
      adSetId: 'new-adset',
      updatedDeploymentIds: ['dep-1', 'dep-2'],
      snapshots,
      updateDeployment,
      deleteAdSet,
      logger,
    });

    expect(updateDeployment).toHaveBeenCalledWith('dep-1', {
      local_adset_id: 'old-adset',
      local_campaign_id: 'old-campaign',
    });
    expect(updateDeployment).toHaveBeenCalledWith('dep-2', {
      local_adset_id: '',
      local_campaign_id: 'unplanned',
    });
    expect(deleteAdSet).toHaveBeenCalledWith('new-adset');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('moves deployments into Planner with the planned sentinel fields', async () => {
    const deployments = new Map([
      ['dep-1', { externalId: 'dep-1', project_id: 'project-1' }],
      ['dep-2', { externalId: 'dep-2', project_id: 'project-1' }],
    ]);
    const getDeploymentByExternalId = vi.fn(async (id) => deployments.get(id) || null);
    const updateDeployment = vi.fn().mockResolvedValue(null);

    const result = await moveDeploymentsToPlanner({
      deploymentIds: ['dep-1', 'dep-2'],
      getDeploymentByExternalId,
      updateDeployment,
    });

    expect(result).toMatchObject({ success: true, count: 2, projectId: 'project-1' });
    expect(updateDeployment).toHaveBeenCalledWith('dep-1', {
      local_campaign_id: 'planned',
      local_adset_id: '',
      flex_ad_id: '',
    });
    expect(updateDeployment).toHaveBeenCalledWith('dep-2', {
      local_campaign_id: 'planned',
      local_adset_id: '',
      flex_ad_id: '',
    });
  });

  it('rejects unknown, deleted, duplicate, and mixed-project Planner moves', async () => {
    expect((await moveDeploymentsToPlanner({
      deploymentIds: [],
      getDeploymentByExternalId: vi.fn(),
      updateDeployment: vi.fn(),
    })).error).toBe('deploymentIds required');

    expect((await moveDeploymentsToPlanner({
      deploymentIds: ['dep-1', 'dep-1'],
      getDeploymentByExternalId: vi.fn(),
      updateDeployment: vi.fn(),
    })).error).toContain('duplicate ids: dep-1');

    const validationDeps = new Map([
      ['deleted', { externalId: 'deleted', project_id: 'project-1', deleted_at: '2026-01-01T00:00:00Z' }],
      ['project-a', { externalId: 'project-a', project_id: 'project-a' }],
      ['project-b', { externalId: 'project-b', project_id: 'project-b' }],
    ]);
    const getDeploymentByExternalId = vi.fn(async (id) => validationDeps.get(id) || null);

    const missingDeleted = await moveDeploymentsToPlanner({
      deploymentIds: ['missing', 'deleted'],
      getDeploymentByExternalId,
      updateDeployment: vi.fn(),
    });
    expect(missingDeleted).toMatchObject({
      success: false,
      status: 400,
      missingIds: ['missing'],
      deletedIds: ['deleted'],
    });

    const mixedProject = await moveDeploymentsToPlanner({
      deploymentIds: ['project-a', 'project-b'],
      getDeploymentByExternalId,
      updateDeployment: vi.fn(),
    });
    expect(mixedProject).toMatchObject({
      success: false,
      status: 400,
      error: 'All selected ads must belong to the same project.',
    });
  });

  it('retries failed Planner move writes once and reports remaining failures', async () => {
    const deployments = new Map([
      ['dep-1', { externalId: 'dep-1', project_id: 'project-1' }],
      ['dep-2', { externalId: 'dep-2', project_id: 'project-1' }],
    ]);
    const getDeploymentByExternalId = vi.fn(async (id) => deployments.get(id) || null);
    const updateDeployment = vi.fn(async (id) => {
      if (id === 'dep-1' && updateDeployment.mock.calls.filter(([calledId]) => calledId === id).length === 1) {
        throw new Error('transient');
      }
      if (id === 'dep-2') throw new Error('persistent');
      return null;
    });
    const logger = { error: vi.fn() };

    const result = await moveDeploymentsToPlanner({
      deploymentIds: ['dep-1', 'dep-2'],
      getDeploymentByExternalId,
      updateDeployment,
      logger,
    });

    expect(result).toMatchObject({
      success: false,
      status: 500,
      failedIds: ['dep-2'],
      count: 1,
    });
    expect(updateDeployment.mock.calls.filter(([id]) => id === 'dep-1')).toHaveLength(2);
    expect(updateDeployment.mock.calls.filter(([id]) => id === 'dep-2')).toHaveLength(2);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
