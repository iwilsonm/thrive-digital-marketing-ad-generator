import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  logCost: vi.fn(),
}));

vi.mock('../convexClient.js', () => ({
  getSetting: mocks.getSetting,
  setSetting: vi.fn(),
  logCost: mocks.logCost,
  getCostAggregates: vi.fn(),
  getDailyCostHistory: vi.fn(),
  getDailyCostHistoryRange: vi.fn(),
  deleteCostsBySource: vi.fn(),
  getAllScheduledBatchesForCost: vi.fn(),
  getAllProjects: vi.fn(),
  getAllConductorConfigs: vi.fn(),
  getAllLPAgentConfigs: vi.fn(),
  getCompletedDirectorBatchStats: vi.fn(),
}));

import { logOpenAIImageCost } from '../services/costTracker.js';

describe('logOpenAIImageCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetting.mockImplementation(async (key) => {
      if (key === 'openai_gpt_image_2_input_rate_per_million') return '10';
      if (key === 'openai_gpt_image_2_output_rate_per_million') return '40';
      return null;
    });
  });

  it('computes cost from actual image token usage and persists token evidence', async () => {
    const record = await logOpenAIImageCost({
      projectId: 'project-1',
      operation: 'ad_image_generation_batch',
      model: 'gpt-image-2',
      size: '1024x1024',
      quality: 'medium',
      usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        total_tokens: 3000,
        input_tokens_details: {
          text_tokens: 700,
          image_tokens: 300,
        },
      },
    });

    expect(record.cost_usd).toBe(0.09);
    expect(mocks.logCost).toHaveBeenCalledWith(expect.objectContaining({
      service: 'openai',
      operation: 'ad_image_generation_batch',
      model: 'gpt-image-2',
      input_tokens: 1000,
      output_tokens: 2000,
      total_tokens: 3000,
      input_text_tokens: 700,
      input_image_tokens: 300,
      quality: 'medium',
      resolution: '1024x1024',
      rate_used: 40,
    }));
  });
});
