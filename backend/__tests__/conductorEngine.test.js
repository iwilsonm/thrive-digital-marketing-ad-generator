import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUuid = vi.fn();

const mockGetConductorConfig = vi.fn();
const mockUpsertConductorConfig = vi.fn();
const mockGetActiveConductorAngles = vi.fn();
const mockGetSystemDefaultAngle = vi.fn();
const mockCreateConductorAngle = vi.fn();
const mockUpdateConductorAngle = vi.fn();
const mockGetConductorPlaybook = vi.fn();
const mockCreateConductorRun = vi.fn();
const mockUpdateConductorRun = vi.fn();
const mockGetConductorRuns = vi.fn();
const mockEnqueueConductorTestRun = vi.fn();
const mockClaimQueuedConductorTestRun = vi.fn();
const mockReleaseQueuedConductorTestRun = vi.fn();
const mockCancelQueuedConductorTestRun = vi.fn();
const mockGetConductorSlotsByPostingDay = vi.fn();
const mockCreateConductorSlot = vi.fn();
const mockUpdateConductorSlot = vi.fn();
const mockCreateBatchJob = vi.fn();
const mockGetBatchJob = vi.fn();
const mockUpdateBatchJob = vi.fn();
const mockGetAdsByBatchId = vi.fn();
const mockGetAd = vi.fn();
const mockGetAdSetsByProject = vi.fn();
const mockGetFlexAdsByProject = vi.fn();
const mockGetBatchesByProject = vi.fn();
const mockGetProject = vi.fn();
const mockGetAllConductorConfigs = vi.fn();
const mockGetSetting = vi.fn();
const mockEnsureDefaultCampaign = vi.fn();
const mockConvexMutation = vi.fn();

const mockGetAdaptiveBatchSize = vi.fn();
const mockRunBatch = vi.fn();
const mockPollBatchJob = vi.fn();
const mockTriggerLPGeneration = vi.fn();
const mockScoreBatchForInlineFilter = vi.fn();
const mockFinalizePassingAds = vi.fn();
const mockScoreAd = vi.fn();
const mockBuildStructuredAnglePrompt = vi.fn();
const mockHasStructuredBrief = vi.fn();
const mockBuildAngleBriefJSON = vi.fn();
const mockGenerateImagePrompt = vi.fn();
const mockRegenerateImageOnly = vi.fn();
const mockRepairBodyCopy = vi.fn();
const mockAssertTemplateTagHasActiveTemplates = vi.fn();
const mockAnthropicChat = vi.fn();

vi.mock('uuid', () => ({
  v4: () => mockUuid(),
}));

vi.mock('../convexClient.js', () => ({
  getConductorConfig: (...args) => mockGetConductorConfig(...args),
  upsertConductorConfig: (...args) => mockUpsertConductorConfig(...args),
  getActiveConductorAngles: (...args) => mockGetActiveConductorAngles(...args),
  getSystemDefaultAngle: (...args) => mockGetSystemDefaultAngle(...args),
  createConductorAngle: (...args) => mockCreateConductorAngle(...args),
  updateConductorAngle: (...args) => mockUpdateConductorAngle(...args),
  getConductorPlaybook: (...args) => mockGetConductorPlaybook(...args),
  createConductorRun: (...args) => mockCreateConductorRun(...args),
  updateConductorRun: (...args) => mockUpdateConductorRun(...args),
  getConductorRuns: (...args) => mockGetConductorRuns(...args),
  enqueueConductorTestRun: (...args) => mockEnqueueConductorTestRun(...args),
  claimQueuedConductorTestRun: (...args) => mockClaimQueuedConductorTestRun(...args),
  releaseQueuedConductorTestRun: (...args) => mockReleaseQueuedConductorTestRun(...args),
  cancelQueuedConductorTestRun: (...args) => mockCancelQueuedConductorTestRun(...args),
  getConductorSlotsByPostingDay: (...args) => mockGetConductorSlotsByPostingDay(...args),
  createConductorSlot: (...args) => mockCreateConductorSlot(...args),
  updateConductorSlot: (...args) => mockUpdateConductorSlot(...args),
  createBatchJob: (...args) => mockCreateBatchJob(...args),
  getBatchJob: (...args) => mockGetBatchJob(...args),
  updateBatchJob: (...args) => mockUpdateBatchJob(...args),
  getAdsByBatchId: (...args) => mockGetAdsByBatchId(...args),
  getAd: (...args) => mockGetAd(...args),
  getAdSetsByProject: (...args) => mockGetAdSetsByProject(...args),
  getFlexAdsByProject: (...args) => mockGetFlexAdsByProject(...args),
  getBatchesByProject: (...args) => mockGetBatchesByProject(...args),
  getProject: (...args) => mockGetProject(...args),
  getAllConductorConfigs: (...args) => mockGetAllConductorConfigs(...args),
  getSetting: (...args) => mockGetSetting(...args),
  ensureDefaultCampaign: (...args) => mockEnsureDefaultCampaign(...args),
  convexClient: {
    mutation: (...args) => mockConvexMutation(...args),
  },
  api: {
    adCreatives: {
      create: 'adCreatives.create',
    },
  },
}));

vi.mock('../services/conductorLearning.js', () => ({
  getAdaptiveBatchSize: (...args) => mockGetAdaptiveBatchSize(...args),
}));

vi.mock('../services/batchProcessor.js', () => ({
  runBatch: (...args) => mockRunBatch(...args),
  pollBatchJob: (...args) => mockPollBatchJob(...args),
}));

vi.mock('../services/lpAutoGenerator.js', () => ({
  triggerLPGeneration: (...args) => mockTriggerLPGeneration(...args),
}));

vi.mock('../services/creativeFilterService.js', () => ({
  scoreBatchForInlineFilter: (...args) => mockScoreBatchForInlineFilter(...args),
  finalizePassingAds: (...args) => mockFinalizePassingAds(...args),
  scoreAd: (...args) => mockScoreAd(...args),
}));

vi.mock('../utils/angleParser.js', () => ({
  buildStructuredAnglePrompt: (...args) => mockBuildStructuredAnglePrompt(...args),
  hasStructuredBrief: (...args) => mockHasStructuredBrief(...args),
  buildAngleBriefJSON: (...args) => mockBuildAngleBriefJSON(...args),
}));

vi.mock('../services/adGenerator.js', () => ({
  generateImagePrompt: (...args) => mockGenerateImagePrompt(...args),
  regenerateImageOnly: (...args) => mockRegenerateImageOnly(...args),
  repairBodyCopy: (...args) => mockRepairBodyCopy(...args),
  normalizeTemplateTag: (tag) => String(tag || '').trim(),
  assertTemplateTagHasActiveTemplates: (...args) => mockAssertTemplateTagHasActiveTemplates(...args),
}));

vi.mock('../services/anthropic.js', () => ({
  chat: (...args) => mockAnthropicChat(...args),
}));

function makeAngle(overrides = {}) {
  return {
    externalId: 'angle-1',
    name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    description: 'Sleep angle',
    prompt_hints: '',
    times_used: 0,
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: 'proj-1',
    externalId: 'proj-1',
    name: 'Heal Naturally',
    brand_name: 'Heal Naturally',
    product_image_storageId: null,
    ...overrides,
  };
}

function makePassingAds(round, count) {
  return Array.from({ length: count }, (_, index) => ({
    ad: {
      id: `round-${round}-pass-${index}`,
      headline: `Headline ${round}-${index}`,
      body_copy: `Body ${round}-${index}`,
    },
    score: {
      ad_id: `round-${round}-pass-${index}`,
      overall_score: 90,
      pass: true,
    },
  }));
}

function makeScoredAds(round, total, passed) {
  return Array.from({ length: total }, (_, index) => ({
    ad: {
      id: `round-${round}-ad-${index}`,
      headline: `Headline ${round}-${index}`,
      body_copy: `Body ${round}-${index}`,
    },
    score: {
      ad_id: `round-${round}-ad-${index}`,
      overall_score: index < passed ? 90 : 40,
      pass: index < passed,
      hard_requirements: { all_passed: index < passed, headline_alignment: index < passed },
      compliance_flags: [],
      spelling_errors: [],
      weaknesses: index < passed ? [] : ['weak hook'],
      strengths: index < passed ? ['clear hook'] : [],
      image_issues: [],
    },
  }));
}

function makeScoreResult(round, total, passed, batch = null) {
  return {
    batch: batch || {
      id: `batch-${round}`,
      pipeline_state: JSON.stringify({
        headline_diagnostics: {
          headline_candidates: total + 4,
          headline_count: total,
          duplicate_rejections: 2,
          history_rejections: 1,
          lane_count: 3,
          lane_distribution: {
            symptom_recognition: Math.max(1, Math.floor(total / 3)),
            failed_solutions: Math.max(1, Math.floor(total / 3)),
            skeptical_confession: Math.max(1, total - (2 * Math.max(1, Math.floor(total / 3)))),
          },
        },
      }),
      gpt_prompts: '[]',
    },
    passingAds: makePassingAds(round, passed),
    scoredAds: makeScoredAds(round, total, passed),
    ads_scored: total,
    ads_passed: passed,
  };
}

async function importConductorEngine() {
  vi.resetModules();
  return import('../services/conductorEngine.js');
}

describe('conductorEngine test-run pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(global, 'setTimeout').mockImplementation((fn, _ms, ...args) => {
      if (typeof fn === 'function') {
        fn(...args);
      }
      return 0;
    });

    mockUuid
      .mockReturnValueOnce('run-uuid-1')
      .mockReturnValueOnce('batch-uuid-1')
      .mockReturnValueOnce('batch-uuid-2')
      .mockReturnValueOnce('batch-uuid-3');

    mockGetConductorRuns.mockResolvedValue([]);
    mockEnqueueConductorTestRun.mockResolvedValue({ queued: true, run: { externalId: 'queued-run-1', queue_position: 1 } });
    mockClaimQueuedConductorTestRun.mockResolvedValue({ claimed: false, reason: 'none_available' });
    mockReleaseQueuedConductorTestRun.mockResolvedValue({ released: true });
    mockCancelQueuedConductorTestRun.mockResolvedValue({ cancelled: false, reason: 'not_queued' });
    mockGetConductorConfig.mockResolvedValue({ enabled: true });
    mockGetProject.mockResolvedValue(makeProject());
    mockGetActiveConductorAngles.mockResolvedValue([makeAngle()]);
    mockGetSystemDefaultAngle.mockResolvedValue(makeAngle({ is_system_default: true }));
    mockCreateConductorAngle.mockResolvedValue();
    mockGetConductorPlaybook.mockResolvedValue(null);
    mockUpdateConductorAngle.mockResolvedValue();
    mockCreateConductorRun.mockResolvedValue();
    mockUpdateConductorRun.mockResolvedValue();
    mockGetConductorSlotsByPostingDay.mockResolvedValue([]);
    mockCreateConductorSlot.mockResolvedValue();
    mockUpdateConductorSlot.mockResolvedValue();
    mockCreateBatchJob.mockResolvedValue();
    mockRunBatch.mockResolvedValue();
    mockPollBatchJob.mockResolvedValue('completed');
    mockFinalizePassingAds.mockResolvedValue({
      flex_ads_created: 1,
      flex_ad_id: 'flex-123',
      ready_to_post_count: 10,
    });
    mockBuildStructuredAnglePrompt.mockImplementation((angle) => angle.description || angle.name);
    mockHasStructuredBrief.mockReturnValue(false);
    mockBuildAngleBriefJSON.mockReturnValue({ frame: 'symptom-first' });
    mockGetFlexAdsByProject.mockResolvedValue([]);
    mockGetAdSetsByProject.mockResolvedValue([]);
    mockGetBatchesByProject.mockResolvedValue([]);
    mockGetAllConductorConfigs.mockResolvedValue([]);
    mockGetSetting.mockImplementation(async (key) => ({
      openai_api_key: 'sk-openai',
      gemini_api_key: 'gemini-key',
      anthropic_api_key: 'sk-anthropic',
    }[key] || null));
    mockEnsureDefaultCampaign.mockResolvedValue('campaign-001');
    mockAnthropicChat.mockResolvedValue('ok');
    mockGetBatchJob.mockResolvedValue(null);
    mockUpdateBatchJob.mockResolvedValue();
    mockGetAdsByBatchId.mockResolvedValue([]);
    mockGetAd.mockImplementation(async (externalId) => ({
      id: externalId,
      externalId,
      project_id: 'proj-1',
      angle: 'Sleep angle',
      angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      headline: `Headline for ${externalId}`,
      body_copy: `Body for ${externalId}`,
      storageId: 'storage-1',
      aspect_ratio: '1:1',
    }));
    mockConvexMutation.mockResolvedValue();
    mockTriggerLPGeneration.mockResolvedValue();
    mockGenerateImagePrompt.mockResolvedValue('documentary image prompt');
    mockRegenerateImageOnly.mockResolvedValue({ id: 'repaired-image-ad' });
    mockRepairBodyCopy.mockResolvedValue({ body_copy: 'Repaired body copy with clear CTA.' });
    mockAssertTemplateTagHasActiveTemplates.mockResolvedValue({ tag: 'sleep', count: 2 });
    mockScoreAd.mockResolvedValue({
      ad_id: 'repair-score',
      overall_score: 45,
      pass: false,
      hard_requirements: { all_passed: false, headline_alignment: true, image_completeness: true },
      compliance_flags: [],
      spelling_errors: [],
      weaknesses: ['still weak'],
      strengths: [],
      image_issues: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the selected target for the first round and tops up with a buffer', async () => {
    mockScoreBatchForInlineFilter
      .mockResolvedValueOnce(makeScoreResult(1, 5, 3))
      .mockResolvedValueOnce(makeScoreResult(2, 4, 2));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.terminal_status).toBe('deployed');
    expect(result.required_passes).toBe(5);
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(2);
    expect(mockCreateBatchJob.mock.calls[0][0].batch_size).toBe(5);
    expect(mockCreateBatchJob.mock.calls[1][0].batch_size).toBe(4);
    expect(mockCreateConductorRun).toHaveBeenCalledWith(expect.objectContaining({
      required_passes: 5,
      ads_per_round: 5,
    }));
  });

  it('queues a test run when another test run is already scoring for the same project', async () => {
    mockGetConductorRuns.mockResolvedValueOnce([
      {
        externalId: 'active-run',
        project_id: 'proj-1',
        run_type: 'test',
        status: 'scoring',
      },
    ]);

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result).toMatchObject({
      queued: true,
      runId: 'queued-run-1',
      queue_position: 1,
    });
    expect(mockEnqueueConductorTestRun).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'proj-1',
      queued_angle_id: 'angle-1',
      required_passes: 5,
    }));
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
  });

  it('queues a test run when a scheduled Director run is active for the same project', async () => {
    mockGetConductorRuns.mockResolvedValueOnce([
      {
        externalId: 'scheduled-run',
        project_id: 'proj-1',
        run_type: 'planning',
        status: 'running',
      },
    ]);

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.queued).toBe(true);
    expect(mockEnqueueConductorTestRun).toHaveBeenCalled();
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
  });

  it('cancels a queued durable test run by runId without touching active batches', async () => {
    mockCancelQueuedConductorTestRun.mockResolvedValueOnce({ cancelled: true });

    const { cancelTestRun } = await importConductorEngine();
    const result = await cancelTestRun('proj-1', { runId: 'queued-run-1' });

    expect(result).toBe(true);
    expect(mockCancelQueuedConductorTestRun).toHaveBeenCalledWith('queued-run-1');
    expect(mockUpdateBatchJob).not.toHaveBeenCalled();
  });

  it('passes the selected approved-ad target into Ready-to-Post finalization', async () => {
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 3, 3));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 3 });

    expect(result.terminal_status).toBe('deployed');
    expect(result.required_passes).toBe(3);
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(1);
    expect(mockCreateBatchJob.mock.calls[0][0].batch_size).toBe(3);
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      targetCount: 3,
    }));
  });

  it('hands test-run Gemini waits to background resume before the Vercel ceiling', async () => {
    let now = Date.parse('2026-05-08T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 70_000;
      return now;
    });
    mockPollBatchJob.mockResolvedValue('processing');

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 3 });

    expect(result).toMatchObject({
      terminal_status: 'waiting_on_gemini',
      run_in_background: true,
    });
    expect(mockUpdateConductorRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({
      status: 'running',
      terminal_status: 'waiting_on_gemini',
      error_stage: 'gemini_waiting',
      last_heartbeat_at: expect.any(String),
    }));
    expect(mockScoreBatchForInlineFilter).not.toHaveBeenCalled();
  });

  it('preflights and persists the selected template tag for test-run batches', async () => {
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 1, 1));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, {
      angleOverride: 'angle-1',
      adsPerAdSetTarget: 1,
      templateTag: ' sleep ',
    });

    expect(result.terminal_status).toBe('deployed');
    expect(mockAssertTemplateTagHasActiveTemplates).toHaveBeenCalledWith('proj-1', 'sleep');
    expect(mockCreateConductorRun).toHaveBeenCalledWith(expect.objectContaining({
      template_tag: 'sleep',
    }));
    expect(mockCreateBatchJob).toHaveBeenCalledWith(expect.objectContaining({
      template_tag: 'sleep',
    }));
  });

  it('uses only active angles matching the configured angle tag filter', async () => {
    mockGetConductorConfig.mockResolvedValue({ enabled: true, angle_tag_filter: 'Sleep' });
    mockGetActiveConductorAngles.mockResolvedValue([
      makeAngle({ externalId: 'angle-1', name: 'Wrong Angle', tags: ['Awareness'] }),
      makeAngle({ externalId: 'angle-2', name: 'Tagged Sleep Angle', tags: ['Sleep'] }),
    ]);
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 1, 1));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { adsPerAdSetTarget: 1 });

    expect(result.terminal_status).toBe('deployed');
    expect(mockCreateBatchJob).toHaveBeenCalledWith(expect.objectContaining({
      angle_name: 'Tagged Sleep Angle',
    }));
  });

  it('blocks before paid generation when the configured angle tag has no active angles', async () => {
    mockGetConductorConfig.mockResolvedValue({ enabled: true, angle_tag_filter: 'Sleep' });
    mockGetActiveConductorAngles.mockResolvedValue([
      makeAngle({ externalId: 'angle-1', name: 'Wrong Angle', tags: ['Awareness'] }),
    ]);

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { adsPerAdSetTarget: 1 });

    expect(result.pipeline_failed).toBe(true);
    expect(result.failure_reason).toContain('No active angles are tagged "Sleep"');
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
  });

  it('resolves an automation campaign before paid test-run generation starts', async () => {
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 5, 5));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.terminal_status).toBe('deployed');
    expect(mockEnsureDefaultCampaign).toHaveBeenCalledWith(expect.objectContaining({
      id: 'proj-1',
    }));
    expect(mockCreateBatchJob).toHaveBeenCalled();
  });

  it('caps top-up rounds at the selected target', async () => {
    mockScoreBatchForInlineFilter
      .mockResolvedValueOnce(makeScoreResult(1, 5, 0))
      .mockResolvedValueOnce(makeScoreResult(2, 5, 5));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.terminal_status).toBe('deployed');
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(2);
    expect(mockCreateBatchJob.mock.calls[0][0].batch_size).toBe(5);
    expect(mockCreateBatchJob.mock.calls[1][0].batch_size).toBe(5);
  });

  it('does not fail the run when headline diagnostics extraction throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const explodingBatch = new Proxy({}, {
      get() {
        throw new Error('diagnostics blew up');
      },
    });
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 5, 5, explodingBatch));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.terminal_status).toBe('deployed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extract headline diagnostics'),
      'diagnostics blew up'
    );
    warnSpy.mockRestore();
  });

  it('does not start another round when repairs push the run to the selected target', async () => {
    const repairableFailures = Array.from({ length: 1 }, (_, index) => ({
      ad: {
        id: `round-1-fail-${index}`,
        headline: `Repairable headline ${index}`,
        body_copy: `Repairable body ${index}`,
        project_id: 'proj-1',
        batch_job_id: 'batch-1',
      },
      score: {
        ad_id: `round-1-fail-${index}`,
        overall_score: 54,
        pass: false,
        hard_requirements: {
          all_passed: false,
          headline_alignment: true,
          first_line_hook: false,
          cta_at_end: true,
          image_completeness: true,
        },
        compliance_flags: [],
        spelling_errors: [],
        weaknesses: ['weak hook'],
        strengths: [],
        image_issues: [],
      },
    }));

    mockScoreBatchForInlineFilter.mockResolvedValueOnce({
      batch: {
        id: 'batch-1',
        pipeline_state: JSON.stringify({}),
        gpt_prompts: '[]',
      },
      passingAds: makePassingAds(1, 4),
      scoredAds: [...makeScoredAds(1, 4, 4), ...repairableFailures],
      ads_scored: 5,
      ads_passed: 4,
    });
    mockScoreAd
      .mockResolvedValueOnce({
        ad_id: 'repair-score-1',
        overall_score: 88,
        pass: true,
        hard_requirements: { all_passed: true, headline_alignment: true, first_line_hook: true, cta_at_end: true, image_completeness: true },
        compliance_flags: [],
        spelling_errors: [],
        weaknesses: [],
        strengths: ['clear hook'],
        image_issues: [],
      })
      .mockResolvedValueOnce({
        ad_id: 'repair-score-2',
        overall_score: 42,
        pass: false,
        hard_requirements: { all_passed: false, headline_alignment: true, first_line_hook: false, cta_at_end: true, image_completeness: true },
        compliance_flags: [],
        spelling_errors: [],
        weaknesses: ['still weak'],
        strengths: [],
        image_issues: [],
      });

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.terminal_status).toBe('deployed');
    expect(result.ads_passed).toBe(5);
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(1);
  });

  it('records post-score failures as orchestration_failed with saved progress', async () => {
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 5, 2));
    mockUpdateConductorRun.mockImplementation(async (_id, fields) => {
      if (fields.status === 'running' && fields.decisions?.startsWith('Round 1 complete:')) {
        throw new Error('round progress write failed');
      }
    });

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.pipeline_failed).toBe(true);
    expect(result.terminal_status).toBe('orchestration_failed');
    expect(result.rounds).toHaveLength(1);

    const failureCall = mockUpdateConductorRun.mock.calls.find(([, fields]) => fields.terminal_status === 'orchestration_failed');
    expect(failureCall?.[1]).toMatchObject({
      error_stage: 'persist_round_progress',
      total_ads_generated: 5,
      total_ads_scored: 5,
      total_ads_passed: 2,
      total_rounds: 1,
    });
  });

  it('blocks before generation when Anthropic is missing', async () => {
    mockGetSetting.mockImplementation(async (key) => ({
      openai_api_key: 'sk-openai',
      gemini_api_key: 'gemini-key',
    }[key] || null));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.pipeline_failed).toBe(true);
    expect(result.failure_reason).toContain('Anthropic API key');
    expect(mockCreateConductorRun).not.toHaveBeenCalled();
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
  });

  it('blocks before generation when no automation campaign can be resolved', async () => {
    mockEnsureDefaultCampaign.mockRejectedValueOnce(new Error('campaign create failed'));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1', adsPerAdSetTarget: 5 });

    expect(result.pipeline_failed).toBe(true);
    expect(result.failure_reason).toContain('could not resolve an automation campaign');
    expect(mockCreateConductorRun).not.toHaveBeenCalled();
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
  });

  it('blocks before generation when the selected template tag has no active templates', async () => {
    mockAssertTemplateTagHasActiveTemplates.mockRejectedValueOnce(new Error('No active templates are tagged "sleep".'));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, {
      angleOverride: 'angle-1',
      adsPerAdSetTarget: 1,
      templateTag: 'sleep',
    });

    expect(result.terminal_status).toBe('generation_failed');
    expect(result.failure_reason).toContain('No active templates are tagged "sleep"');
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
  });

  it('resumes a completed background round without referencing an undefined batch', async () => {
    const runAt = Date.parse('2026-03-07T10:00:00Z');
    mockGetAllConductorConfigs.mockResolvedValue([{ project_id: 'proj-1' }]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: runAt,
        status: 'running',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 5, round: 1 },
        ]),
        rounds_json: '[]',
        total_ads_generated: 5,
        total_ads_scored: 0,
        total_ads_passed: 0,
        required_passes: 5,
        ads_per_round: 5,
        skip_lp_gen: false,
      },
    ]);
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-uuid-1',
      externalId: 'batch-uuid-1',
      status: 'completed',
      angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      angle_prompt: 'Sleep angle',
      angle_brief: null,
      batch_size: 5,
    });
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 5, 5));

    const { resumeBackgroundTestRuns } = await importConductorEngine();
    await resumeBackgroundTestRuns();

    expect(mockTriggerLPGeneration).not.toHaveBeenCalled();

    const completedCall = mockUpdateConductorRun.mock.calls.find(([, fields]) => fields.terminal_status === 'deployed');
    expect(completedCall).toBeTruthy();
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      targetCount: 5,
    }));
  });

  it('recovers a stale scoring claim after a completed top-up batch was not scored', async () => {
    const runAt = Date.parse('2026-05-04T10:00:00Z');
    mockGetAllConductorConfigs.mockResolvedValue([{ project_id: 'proj-1' }]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: runAt,
        status: 'scoring',
        terminal_status: 'waiting_on_gemini',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 1, round: 1, ads_scored: 1, ads_passed: 0 },
          { batch_id: 'batch-uuid-2', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 2, round: 2 },
        ]),
        rounds_json: JSON.stringify([
          { round: 1, batch_id: 'batch-uuid-1', ads_generated: 1, ads_scored: 1, ads_passed: 0, cumulative_passed: 0 },
        ]),
        total_ads_generated: 3,
        total_ads_scored: 1,
        total_ads_passed: 0,
        required_passes: 1,
        ads_per_round: 1,
      },
    ]);
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-uuid-2',
      externalId: 'batch-uuid-2',
      status: 'completed',
      angle_name: 'The Sleep Hacks Are Exhausting',
      angle_prompt: 'Sleep angle',
      angle_brief: null,
      batch_size: 2,
      filter_processed: false,
    });
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(2, 2, 1));

    const { resumeBackgroundTestRuns } = await importConductorEngine();
    const result = await resumeBackgroundTestRuns();

    expect(result).toEqual({ checked: 1, resumed: 1, errors: 0 });
    expect(mockScoreBatchForInlineFilter).toHaveBeenCalledWith('batch-uuid-2', 'proj-1', expect.any(Function), expect.objectContaining({
      roundNumber: 2,
    }));
    expect(mockUpdateConductorRun).toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      status: 'scoring',
      terminal_status: 'filter_scoring',
      error_stage: 'filter_scoring',
      scoring_started_at: expect.any(Number),
    }));
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      batchId: 'batch-uuid-2',
      targetCount: 1,
    }));
  });

  it('queues pending background test rounds for the scheduler instead of leaving them stranded', async () => {
    const runAt = Date.parse('2026-03-07T10:00:00Z');
    mockGetAllConductorConfigs.mockResolvedValue([{ project_id: 'proj-1' }]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: runAt,
        status: 'running',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 5, round: 1, ads_scored: 5, ads_passed: 0 },
          { batch_id: 'batch-uuid-2', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 5, round: 2 },
        ]),
        rounds_json: JSON.stringify([
          { round: 1, batch_id: 'batch-uuid-1', ads_generated: 5, ads_scored: 5, ads_passed: 0, cumulative_passed: 0 },
        ]),
        total_ads_generated: 10,
        total_ads_scored: 5,
        total_ads_passed: 0,
        required_passes: 5,
        ads_per_round: 5,
      },
    ]);
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-uuid-2',
      externalId: 'batch-uuid-2',
      status: 'pending',
      angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      angle_prompt: 'Sleep angle',
      angle_brief: null,
      batch_size: 5,
    });

    const { resumeBackgroundTestRuns } = await importConductorEngine();
    const result = await resumeBackgroundTestRuns();

    expect(result).toEqual({ checked: 1, resumed: 1, errors: 0 });
    expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-uuid-2', expect.objectContaining({
      status: 'queued',
      queued_at: expect.any(String),
      last_heartbeat_at: expect.any(String),
    }));
    expect(mockUpdateConductorRun).toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      status: 'running',
      terminal_status: 'queued_round',
    }));
    expect(mockScoreBatchForInlineFilter).not.toHaveBeenCalled();
  });

  it('retries a background round instead of terminally failing on legacy auto-post log import skew', async () => {
    const runAt = Date.parse('2026-05-04T10:00:00Z');
    mockGetAllConductorConfigs.mockResolvedValue([{ project_id: 'proj-1' }]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: runAt,
        status: 'running',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 1, round: 1 },
        ]),
        rounds_json: '[]',
        total_ads_generated: 1,
        total_ads_scored: 0,
        total_ads_passed: 0,
        required_passes: 1,
        ads_per_round: 1,
      },
    ]);
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-uuid-1',
      externalId: 'batch-uuid-1',
      status: 'completed',
      angle_name: 'The Sleep Hacks Are Exhausting',
      angle_prompt: 'Sleep angle',
      angle_brief: null,
      batch_size: 1,
    });
    mockScoreBatchForInlineFilter.mockRejectedValueOnce(new Error("The requested module '../convexClient.js' does not provide an export named 'createAutoPostLog'"));

    const { resumeBackgroundTestRuns } = await importConductorEngine();
    const result = await resumeBackgroundTestRuns();

    expect(result).toEqual({ checked: 1, resumed: 1, errors: 0 });
    expect(mockUpdateConductorRun).toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      status: 'running',
      terminal_status: 'filter_scoring_retry',
      error: '',
      failure_reason: '',
    }));
    expect(mockUpdateConductorRun).not.toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      terminal_status: 'orchestration_failed',
    }));
  });

  it('auto-repairs legacy auto-post-log import failed runs during background resume', async () => {
    const runAt = Date.parse('2026-05-04T10:00:00Z');
    mockGetAllConductorConfigs.mockResolvedValue([{ project_id: 'proj-1' }]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: runAt,
        status: 'failed',
        terminal_status: 'orchestration_failed',
        error_stage: 'post_score_round_processing',
        failure_reason: "The requested module '../convexClient.js' does not provide an export named 'createAutoPostLog'",
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 1, round: 1 },
        ]),
        rounds_json: '[]',
        total_ads_generated: 1,
        total_ads_scored: 0,
        total_ads_passed: 0,
        required_passes: 1,
        ads_per_round: 1,
      },
    ]);
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 1, 1));

    const { resumeBackgroundTestRuns } = await importConductorEngine();
    const result = await resumeBackgroundTestRuns();

    expect(result).toEqual({ checked: 1, resumed: 1, errors: 0 });
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
    expect(mockScoreBatchForInlineFilter).toHaveBeenCalledWith('batch-uuid-1', 'proj-1', null, expect.objectContaining({
      roundNumber: 1,
    }));
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      targetCount: 1,
    }));
  });

  it('cancels durable background test runs instead of only in-memory runs', async () => {
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: Date.parse('2026-03-07T10:00:00Z'),
        status: 'scoring',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 5, round: 1, ads_scored: 5, ads_passed: 2 },
          { batch_id: 'batch-uuid-2', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 4, round: 2 },
        ]),
        rounds_json: JSON.stringify([
          { round: 1, batch_id: 'batch-uuid-1', ads_generated: 5, ads_scored: 5, ads_passed: 2, cumulative_passed: 2 },
        ]),
        total_ads_generated: 9,
        total_ads_scored: 5,
        total_ads_passed: 2,
        required_passes: 5,
      },
    ]);
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-uuid-2',
      externalId: 'batch-uuid-2',
      status: 'processing',
      gemini_batch_job: null,
    });

    const { cancelTestRun } = await importConductorEngine();
    const cancelled = await cancelTestRun('proj-1');

    expect(cancelled).toBe(true);
    expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-uuid-2', expect.objectContaining({
      status: 'failed',
      error_message: 'Cancelled by user',
    }));
    expect(mockUpdateConductorRun).toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      status: 'failed',
      terminal_status: 'cancelled',
      error: 'Cancelled by user',
      failure_reason: 'Cancelled by user',
      ready_to_post_count: 0,
    }));
  });

  it('repairs deploy-failed test runs without creating new image batches', async () => {
    const roundsJson = JSON.stringify([
      {
        round: 1,
        batch_id: 'batch-uuid-1',
        angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
        ads_generated: 5,
        ads_scored: 5,
        ads_passed: 5,
        cumulative_passed: 5,
        passing_ads: makePassingAds(1, 5).map(({ ad, score }) => ({
          ad_id: ad.id,
          headline: ad.headline,
          overall_score: score.overall_score,
        })),
      },
    ]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: Date.parse('2026-03-07T10:00:00Z'),
        status: 'failed',
        terminal_status: 'deploy_failed',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 5, round: 1 },
        ]),
        rounds_json: roundsJson,
        total_ads_generated: 5,
        total_ads_scored: 5,
        total_ads_passed: 5,
        required_passes: 5,
        ads_per_round: 5,
      },
    ]);
    mockGetAdsByBatchId.mockResolvedValue(makePassingAds(1, 5).map(({ ad }) => ad));

    const { repairDeployFailedTestRun } = await importConductorEngine();
    const result = await repairDeployFailedTestRun('proj-1', 'run-uuid-1');

    expect(result).toMatchObject({
      repaired: true,
      status: 'deployed',
      runId: 'run-uuid-1',
    });
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      batchId: 'batch-uuid-1',
      targetCount: 5,
    }));
    expect(mockUpdateConductorRun).toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      terminal_status: 'deployed',
      ready_to_post_count: 10,
    }));
  });

  it('repairs grouping-failed test runs without creating new image batches', async () => {
    const roundsJson = JSON.stringify([
      {
        round: 1,
        batch_id: 'batch-uuid-1',
        angle_name: 'The Sleep Hacks Are Exhausting',
        ads_generated: 1,
        ads_scored: 1,
        ads_passed: 1,
        cumulative_passed: 1,
        passing_ads: [
          { ad_id: 'round-1-pass-0', headline: 'Approved headline', overall_score: 8.1 },
        ],
      },
    ]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: Date.parse('2026-05-04T10:00:00Z'),
        status: 'failed',
        terminal_status: 'grouping_failed',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 1, round: 1 },
        ]),
        rounds_json: roundsJson,
        total_ads_generated: 1,
        total_ads_scored: 1,
        total_ads_passed: 1,
        required_passes: 1,
        ads_per_round: 1,
      },
    ]);
    mockGetAdsByBatchId.mockResolvedValue([makePassingAds(1, 1)[0].ad]);

    const { repairDeployFailedTestRun } = await importConductorEngine();
    const result = await repairDeployFailedTestRun('proj-1', 'run-uuid-1');

    expect(result).toMatchObject({
      repaired: true,
      status: 'deployed',
      runId: 'run-uuid-1',
    });
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      batchId: 'batch-uuid-1',
      targetCount: 1,
    }));
  });

  it('repairs legacy auto-post-log import failures by scoring existing completed batches', async () => {
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: Date.parse('2026-05-04T10:00:00Z'),
        status: 'failed',
        terminal_status: 'orchestration_failed',
        error_stage: 'post_score_round_processing',
        failure_reason: "The requested module '../convexClient.js' does not provide an export named 'createAutoPostLog'",
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 2, round: 1 },
        ]),
        rounds_json: '[]',
        total_ads_generated: 2,
        total_ads_scored: 0,
        total_ads_passed: 0,
        required_passes: 2,
        ads_per_round: 2,
      },
    ]);
    mockScoreBatchForInlineFilter.mockResolvedValue(makeScoreResult(1, 2, 2));

    const { repairDeployFailedTestRun } = await importConductorEngine();
    const result = await repairDeployFailedTestRun('proj-1', 'run-uuid-1');

    expect(result).toMatchObject({
      repaired: true,
      status: 'deployed',
      runId: 'run-uuid-1',
    });
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
    expect(mockScoreBatchForInlineFilter).toHaveBeenCalledWith('batch-uuid-1', 'proj-1', null, expect.objectContaining({
      roundNumber: 1,
    }));
    expect(mockFinalizePassingAds).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      batchId: 'batch-uuid-1',
      targetCount: 2,
    }));
  });

  it('records a clear under-target state when legacy repair scoring does not reach the target', async () => {
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: Date.parse('2026-05-04T10:00:00Z'),
        status: 'failed',
        terminal_status: 'orchestration_failed',
        error_stage: 'post_score_round_processing',
        error: "The requested module '../convexClient.js' does not provide an export named 'createAutoPostLog'",
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'The Sleep Hacks Are Exhausting', ad_count: 2, round: 1 },
        ]),
        rounds_json: '[]',
        total_ads_generated: 2,
        total_ads_scored: 0,
        total_ads_passed: 0,
        required_passes: 2,
        ads_per_round: 2,
      },
    ]);
    mockScoreBatchForInlineFilter.mockResolvedValue(makeScoreResult(1, 2, 1));

    const { repairDeployFailedTestRun } = await importConductorEngine();
    const result = await repairDeployFailedTestRun('proj-1', 'run-uuid-1');

    expect(result).toMatchObject({
      repaired: false,
      status: 'repair_under_target',
      runId: 'run-uuid-1',
      passed: 1,
      requiredPasses: 2,
    });
    expect(mockCreateBatchJob).not.toHaveBeenCalled();
    expect(mockFinalizePassingAds).not.toHaveBeenCalled();
    expect(mockUpdateConductorRun).toHaveBeenCalledWith('run-uuid-1', expect.objectContaining({
      status: 'failed',
      terminal_status: 'repair_under_target',
      error_stage: 'repair_scoring',
      total_ads_scored: 2,
      total_ads_passed: 1,
      failure_reason: expect.stringContaining('only 1/2 passed'),
    }));
  });

  it('hydrates Director slot angles from the full conductor_angles row before creating a batch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-06T21:00:00.000Z'));

    const richAngle = makeAngle({
      externalId: 'angle-rich-1',
      name: 'Everyone Brings Their Pain To Her',
      description: 'A calling angle about being the person others already bring pain to before formal training.',
      prompt_hints: 'Center the weight of being trusted before feeling equipped.',
      frame: 'calling-without-credentials',
      core_buyer: 'Christians who are already trusted with painful conversations',
      symptom_pattern: 'People bring heavy stories to them, but they feel unsure how to respond wisely',
      times_used: 2,
    });
    mockGetConductorConfig.mockResolvedValue({
      enabled: true,
      daily_flex_target: 1,
      ads_per_batch: 6,
    });
    mockGetActiveConductorAngles.mockResolvedValue([richAngle]);
    mockGetConductorSlotsByPostingDay.mockResolvedValue([{
      id: 'slot-1',
      posting_day: '2026-05-08',
      slot_index: 0,
      angle_name: richAngle.name,
      angle_external_id: richAngle.externalId,
      status: 'reserved',
      batch_ids: '[]',
      attempt_count: 0,
      failure_reason: '',
    }]);
    mockHasStructuredBrief.mockImplementation((angle) => Boolean(angle.frame || angle.core_buyer));
    mockBuildStructuredAnglePrompt.mockImplementation((angle) => [
      angle.name,
      angle.description,
      angle.core_buyer,
      angle.symptom_pattern,
    ].filter(Boolean).join('\n'));
    mockBuildAngleBriefJSON.mockImplementation((angle) => ({
      name: angle.name,
      description: angle.description,
      frame: angle.frame,
      core_buyer: angle.core_buyer,
      symptom_pattern: angle.symptom_pattern,
    }));

    const { runDirectorForProject } = await importConductorEngine();
    const result = await runDirectorForProject('proj-1', 'manual');

    expect(result.batches_created).toBe(1);
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(1);
    const batchPayload = mockCreateBatchJob.mock.calls[0][0];
    expect(batchPayload).toMatchObject({
      angle_name: richAngle.name,
      angle_prompt: expect.stringContaining(richAngle.description),
      angle: expect.stringContaining(richAngle.core_buyer),
    });
    expect(batchPayload.angle_prompt).toContain('CREATIVE DIRECTION');
    expect(batchPayload.angle_prompt).toContain(richAngle.prompt_hints);
    expect(JSON.parse(batchPayload.angle_brief)).toMatchObject({
      description: richAngle.description,
      frame: richAngle.frame,
      core_buyer: richAngle.core_buyer,
      symptom_pattern: richAngle.symptom_pattern,
    });
    expect(mockBuildStructuredAnglePrompt).toHaveBeenCalledWith(expect.objectContaining({
      externalId: richAngle.externalId,
      description: richAngle.description,
      core_buyer: richAngle.core_buyer,
    }));
    expect(mockUpdateConductorAngle).toHaveBeenCalledWith(richAngle.externalId, expect.objectContaining({
      times_used: 3,
    }));
  });
});

describe('conductorEngine Director ad-set top-up helpers', () => {
  it('uses project ads_per_ad_set as the approved-ad target before legacy config fallback', async () => {
    const { getDirectorAdSetTarget } = await importConductorEngine();

    expect(getDirectorAdSetTarget({ ads_per_ad_set: 5 }, { ads_per_batch: 12 })).toBe(5);
    expect(getDirectorAdSetTarget({}, { ads_per_batch: 7 })).toBe(7);
    expect(getDirectorAdSetTarget({}, {})).toBe(5);
    expect(getDirectorAdSetTarget({ ads_per_ad_set: 99 }, { ads_per_batch: 7 })).toBe(20);
  });

  it('sizes top-up batches as missing approved ads plus a small buffer capped by target', async () => {
    const { getDirectorTopUpBatchSize } = await importConductorEngine();

    expect(getDirectorTopUpBatchSize(5, 3)).toBe(4);
    expect(getDirectorTopUpBatchSize(5, 4)).toBe(3);
    expect(getDirectorTopUpBatchSize(5, 0)).toBe(5);
    expect(getDirectorTopUpBatchSize(5, 5)).toBe(0);
  });
});
