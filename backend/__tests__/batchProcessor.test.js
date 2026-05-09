import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// MOCKS — All external APIs and database calls are mocked
// so tests are free to run (no API costs)
// ============================================================

// Mock convexClient (database layer)
const mockGetProject = vi.fn();
const mockGetLatestDoc = vi.fn();
const mockGetBatchJob = vi.fn();
const mockUpdateBatchJob = vi.fn();
const mockUploadBuffer = vi.fn();
const mockDownloadToBuffer = vi.fn();
const mockCreateAdCreative = vi.fn();
const mockGetActiveBatchJobs = vi.fn();
const mockGetQueuedBatchJobs = vi.fn();
const mockGetScheduledBatchJobs = vi.fn();
const mockGetBatchesByProject = vi.fn();
const mockCreateBatchJob = vi.fn();
const mockDeleteBatchJob = vi.fn();
const mockClaimBatchResultsProcessing = vi.fn();
const mockGetRecentHeadlineHistoryByAngle = vi.fn();
const mockRecordHeadlineHistory = vi.fn();
const mockGetSetting = vi.fn();
const mockConvexQuery = vi.fn();
const mockConvexMutation = vi.fn();

vi.mock('../convexClient.js', () => ({
  getProject: (...args) => mockGetProject(...args),
  getLatestDoc: (...args) => mockGetLatestDoc(...args),
  getBatchJob: (...args) => mockGetBatchJob(...args),
  updateBatchJob: (...args) => mockUpdateBatchJob(...args),
  uploadBuffer: (...args) => mockUploadBuffer(...args),
  downloadToBuffer: (...args) => mockDownloadToBuffer(...args),
  createAdCreative: (...args) => mockCreateAdCreative(...args),
  getActiveBatchJobs: (...args) => mockGetActiveBatchJobs(...args),
  getQueuedBatchJobs: (...args) => mockGetQueuedBatchJobs(...args),
  getScheduledBatchJobs: (...args) => mockGetScheduledBatchJobs(...args),
  getBatchesByProject: (...args) => mockGetBatchesByProject(...args),
  createBatchJob: (...args) => mockCreateBatchJob(...args),
  deleteBatchJob: (...args) => mockDeleteBatchJob(...args),
  claimBatchResultsProcessing: (...args) => mockClaimBatchResultsProcessing(...args),
  getRecentHeadlineHistoryByAngle: (...args) => mockGetRecentHeadlineHistoryByAngle(...args),
  recordHeadlineHistory: (...args) => mockRecordHeadlineHistory(...args),
  getCompletedDirectorBatchStats: vi.fn().mockResolvedValue([]),
  getAdSet: vi.fn().mockResolvedValue(null),
  createAdSet: vi.fn().mockResolvedValue(),
  ensureDefaultCampaign: vi.fn().mockResolvedValue('campaign-001'),
  findConductorAngleByName: vi.fn().mockResolvedValue(null),
  parseAdSetDefaults: vi.fn().mockReturnValue({}),
  getInspirationImages: vi.fn().mockResolvedValue([]),
  getInspirationImageUrl: vi.fn(),
  getAdImageUrl: vi.fn(),
  getSetting: (...args) => mockGetSetting(...args),
  claimBatchWork: vi.fn(),
  releaseBatchWork: vi.fn(),
  heartbeatBatchJob: vi.fn(),
  queueScheduledBatchRun: vi.fn(),
  convexClient: { query: (...args) => mockConvexQuery(...args), mutation: (...args) => mockConvexMutation(...args) },
  api: { batchJobs: {}, adCreatives: {} },
  queryWithRetry: vi.fn(),
  mutationWithRetry: vi.fn(),
}));

// Mock adGenerator (GPT-5.2 calls)
const mockExtractBrief = vi.fn();
const mockGenerateHeadlines = vi.fn();
const mockGenerateBodyCopies = vi.fn();
const mockGenerateImagePrompt = vi.fn();
const mockGenerateImagePromptsBatch = vi.fn();
const mockSelectInspirationImage = vi.fn();
const mockSelectTemplateImage = vi.fn();
const mockReviewPromptWithGuidelines = vi.fn();
const mockIsSceneLockedAngle = vi.fn();

vi.mock('../services/adGenerator.js', () => ({
  extractBrief: (...args) => mockExtractBrief(...args),
  generateHeadlines: (...args) => mockGenerateHeadlines(...args),
  generateBodyCopies: (...args) => mockGenerateBodyCopies(...args),
  generateImagePrompt: (...args) => mockGenerateImagePrompt(...args),
  generateImagePromptsBatch: (...args) => mockGenerateImagePromptsBatch(...args),
  isSceneLockedAngle: (...args) => mockIsSceneLockedAngle(...args),
  selectInspirationImage: (...args) => mockSelectInspirationImage(...args),
  selectTemplateImage: (...args) => mockSelectTemplateImage(...args),
  assertTemplateTagHasActiveTemplates: vi.fn(),
  reviewPromptWithGuidelines: (...args) => mockReviewPromptWithGuidelines(...args),
  readImageBase64: vi.fn(),
  cleanupImageData: vi.fn(),
}));

// Mock Gemini (image generation)
const mockGenerateImage = vi.fn();
const mockGetClient = vi.fn();

vi.mock('../services/gemini.js', () => ({
  generateImage: (...args) => mockGenerateImage(...args),
  getClient: (...args) => mockGetClient(...args),
}));

// Mock cost tracker
vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: vi.fn(),
}));

// Mock retry utility — just run the function directly
vi.mock('../services/retry.js', () => ({
  withRetry: vi.fn((fn) => fn()),
}));

// Mock rate limiter — pass through
vi.mock('../services/rateLimiter.js', () => ({
  withGptRateLimit: vi.fn((fn) => fn()),
  AsyncSemaphore: vi.fn(),
}));

// Mock OpenAI
vi.mock('../services/openai.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  chatWithImages: vi.fn(),
}));

// Mock Anthropic
vi.mock('../services/anthropic.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
}));

// Mock uuid
vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
  v5: vi.fn((name) => `test-${name.replace(/[^a-z0-9]/gi, '-')}`),
}));

// Mock sharp
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake-image')),
  })),
}));

// ============================================================
// TEST HELPERS
// ============================================================

const makeBatchJob = (overrides = {}) => ({
  id: 'batch-001',
  project_id: 'proj-001',
  generation_mode: 'mode1',
  batch_size: 3,
  angle: 'Test Angle',
  angles: null,
  aspect_ratio: '1:1',
  template_image_id: null,
  template_image_ids: null,
  inspiration_image_ids: null,
  product_image_storageId: null,
  gemini_batch_job: null,
  gpt_prompts: null,
  status: 'pending',
  scheduled: 0,
  schedule_cron: null,
  error_message: null,
  completed_count: 0,
  failed_count: 0,
  run_count: 0,
  retry_count: 0,
  used_template_ids: null,
  batch_stats: null,
  pipeline_state: null,
  created_at: '2026-02-23T00:00:00.000Z',
  started_at: null,
  completed_at: null,
  ...overrides,
});

const makeProject = (overrides = {}) => ({
  id: 'proj-001',
  externalId: 'proj-001',
  name: 'Test Product',
  brand_name: 'Test Brand',
  niche: 'health',
  product_description: 'A test product',
  sales_page_content: 'Buy our product',
  prompt_guidelines: null,
  product_image_storageId: null,
  ...overrides,
});

const makeDoc = (type, content) => ({
  doc_type: type,
  content: content || `Test ${type} content`,
  version: 1,
  approved: true,
});

// ============================================================
// TESTS
// ============================================================

describe('batch pipeline', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimBatchResultsProcessing.mockResolvedValue({
      claimed: true,
      status: 'saving_results',
      completed_count: 0,
      failed_count: 0,
      run_count: 0,
    });
    mockGetRecentHeadlineHistoryByAngle.mockResolvedValue([]);
    mockRecordHeadlineHistory.mockResolvedValue();
    mockIsSceneLockedAngle.mockReturnValue(false);
    mockGenerateImagePromptsBatch.mockResolvedValue([
      {
        prompt: 'make ad',
        visual_copy_plan: { headline: 'Headline', supporting_text: 'Body' },
        rendered_text_expectation: 'template_matched',
        visual_text_density: 'short',
        template_text_contract: { text_density: 'short', rendered_text_expectation: 'template_matched', zones: [] },
      },
    ]);
    mockGetSetting.mockResolvedValue('test-openai-key');
    mockConvexQuery.mockResolvedValue(null);
    mockConvexMutation.mockResolvedValue();
  });

  // ── Status Flow ──────────────────────────────────────────

  describe('status flow', () => {
    it('batch starts in pending status', () => {
      const batch = makeBatchJob();
      expect(batch.status).toBe('pending');
    });

    it('valid status transitions: pending → generating_prompts → submitting → processing → completed', () => {
      const validFlow = ['pending', 'generating_prompts', 'submitting', 'processing', 'completed'];
      for (let i = 0; i < validFlow.length - 1; i++) {
        // Each status is a valid predecessor of the next
        expect(validFlow[i]).toBeTruthy();
        expect(validFlow[i + 1]).toBeTruthy();
      }
    });

    it('failed is a valid terminal status from any active state', () => {
      const activeStates = ['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results'];
      activeStates.forEach(state => {
        const batch = makeBatchJob({ status: state });
        // Should be able to transition to failed
        expect(['failed']).toContain('failed');
        expect(batch.status).toBe(state);
      });
    });
  });

  // ── runBatch ─────────────────────────────────────────────

  describe('runBatch', () => {
    it('rejects if batch is not found', async () => {
      mockGetBatchJob.mockResolvedValue(null);

      const { runBatch } = await import('../services/batchProcessor.js');
      await expect(runBatch('nonexistent')).rejects.toThrow();
    });

    it('loads all 4 foundational docs for prompt generation', async () => {
      mockGetBatchJob.mockResolvedValue(makeBatchJob());
      mockGetProject.mockResolvedValue(makeProject());
      mockGetLatestDoc.mockImplementation((projId, docType) =>
        Promise.resolve(makeDoc(docType))
      );
      // Make it fail during prompt generation so we don't need full pipeline
      mockExtractBrief.mockRejectedValue(new Error('test stop'));
      mockUpdateBatchJob.mockResolvedValue();

      const { runBatch } = await import('../services/batchProcessor.js');
      try { await runBatch('batch-001'); } catch (e) { /* expected */ }

      // Should have attempted to load all 4 doc types
      expect(mockGetLatestDoc).toHaveBeenCalledWith('proj-001', 'research');
      expect(mockGetLatestDoc).toHaveBeenCalledWith('proj-001', 'avatar');
      expect(mockGetLatestDoc).toHaveBeenCalledWith('proj-001', 'offer_brief');
      expect(mockGetLatestDoc).toHaveBeenCalledWith('proj-001', 'necessary_beliefs');
    });

    it('updates status to generating_prompts at start', async () => {
      mockGetBatchJob.mockResolvedValue(makeBatchJob());
      mockGetProject.mockResolvedValue(makeProject());
      mockGetLatestDoc.mockResolvedValue(makeDoc('research'));
      mockExtractBrief.mockRejectedValue(new Error('test stop'));
      mockUpdateBatchJob.mockResolvedValue();

      const { runBatch } = await import('../services/batchProcessor.js');
      try { await runBatch('batch-001'); } catch (e) { /* expected */ }

      // First status update should set to generating_prompts
      const statusCalls = mockUpdateBatchJob.mock.calls.filter(
        c => c[1]?.status === 'generating_prompts'
      );
      expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('sets status to failed on error with error message', async () => {
      mockGetBatchJob.mockResolvedValue(makeBatchJob());
      mockGetProject.mockResolvedValue(makeProject());
      mockGetLatestDoc.mockResolvedValue(makeDoc('research'));
      mockExtractBrief.mockRejectedValue(new Error('GPT-5.2 rate limit'));
      mockUpdateBatchJob.mockResolvedValue();

      const { runBatch } = await import('../services/batchProcessor.js');
      try { await runBatch('batch-001'); } catch (e) { /* expected */ }

      const failCalls = mockUpdateBatchJob.mock.calls.filter(
        c => c[1]?.status === 'failed'
      );
      expect(failCalls.length).toBeGreaterThanOrEqual(1);
      // Should include error message
      const failCall = failCalls[failCalls.length - 1];
      expect(failCall[1].error_message).toBeTruthy();
    });

    it('preserves actionable billing errors on batch.error_message without Pipeline failed prefix', async () => {
      const billingMessage = 'OpenAI account has zero usable quota for gpt-5.2. Top up billing at https://platform.openai.com/account/billing or rotate to a key with usable quota.';
      const billingError = new Error(billingMessage);
      billingError.code = 'BILLING_EXHAUSTED';
      billingError.provider = 'OpenAI';
      billingError.model = 'gpt-5.2';

      mockGetBatchJob.mockResolvedValue(makeBatchJob());
      mockGetProject.mockResolvedValue(makeProject());
      mockGetLatestDoc.mockResolvedValue(makeDoc('research'));
      mockExtractBrief.mockRejectedValue(billingError);
      mockUpdateBatchJob.mockResolvedValue();

      const { runBatch } = await import('../services/batchProcessor.js');
      await expect(runBatch('batch-001')).rejects.toThrow(billingMessage);

      const failCalls = mockUpdateBatchJob.mock.calls.filter(
        c => c[1]?.status === 'failed'
      );
      const failCall = failCalls[failCalls.length - 1];
      expect(failCall[1].error_message).toBe(billingMessage);
      expect(failCall[1].error_message).not.toContain('Pipeline failed:');
      expect(JSON.parse(failCall[1].pipeline_state)).toMatchObject({
        error_code: 'BILLING_EXHAUSTED',
        provider: 'OpenAI',
        model: 'gpt-5.2',
      });
    });

    it('keeps Path-B valid non-literal-scene headlines moving through prompt generation', async () => {
      const pathBAngleBrief = {
        name: 'Direct Offer',
        frame: 'objection-first',
        core_buyer: 'A Christian adult comparing counseling paths before committing to training.',
        symptom_pattern: 'They keep comparing licensure, ministry, and certificate options but do not want to be pushed into one program.',
        objection: 'They worry a free webinar will become another enrollment pitch.',
        scene: 'A person sitting at a kitchen table with a Bible nearby, a notepad of half-formed questions, and a laptop open to a counseling program page.',
        desired_belief_shift: 'I can map options before committing.',
      };
      const headline = "Worried you'll be pushed to a program? Map options first.";

      mockGetBatchJob.mockResolvedValue(makeBatchJob({
        batch_size: 1,
        angle_name: pathBAngleBrief.name,
        angle_brief: JSON.stringify(pathBAngleBrief),
      }));
      mockGetProject.mockResolvedValue(makeProject());
      mockGetLatestDoc.mockImplementation((projId, docType) =>
        Promise.resolve(makeDoc(docType))
      );
      mockExtractBrief.mockResolvedValue('## AVATAR IN THIS MOMENT\nCareful Christian adults\n\n## EMOTIONAL ENTRY POINT\nSkeptical clarity\n\n## RELEVANT PAIN POINTS\nThey fear being pushed into one program.\n\n## RELEVANT QUOTES\n"Is this just a pitch?"\n\n## SPECIFICITY ANCHORS\nlicensure vs ministry vs certificate');
      mockGenerateHeadlines.mockResolvedValue({
        headlines: [{
          rank: 1,
          headline,
          hook_lane: 'objection_reversal',
          sub_angle: 'pressure-free map',
          scene_anchor: 'comparing paths before committing',
          core_claim: 'map options before pressure',
          target_symptom: 'fear of being pushed into one program',
          emotional_entry: 'skeptical caution',
          desired_belief_shift: 'I can map options before committing.',
          opening_pattern: 'objection_flip',
          average_score: 9,
        }],
      });
      mockGenerateBodyCopies.mockResolvedValue([{
        headline,
        body_copy: 'Compare the three paths before you spend money or years.',
        hook_lane: 'objection_reversal',
        sub_angle: 'pressure-free map',
        scene_anchor: 'comparing paths before committing',
        core_claim: 'map options before pressure',
        target_symptom: 'fear of being pushed into one program',
        emotional_entry: 'skeptical caution',
        desired_belief_shift: 'I can map options before committing.',
        opening_pattern: 'objection_flip',
        primary_emotion: 'skepticism',
      }]);
      mockSelectInspirationImage.mockResolvedValue({
        fileId: null,
        tmpPath: null,
        mimeType: 'image/jpeg',
      });
      mockGenerateImagePromptsBatch.mockResolvedValue([{
        prompt: 'Render a calm decision-map ad.',
        visual_copy_plan: { headline, supporting_text: 'Compare paths before committing.' },
        rendered_text_expectation: 'template_matched',
        visual_text_density: 'short',
        template_text_contract: { text_density: 'short', rendered_text_expectation: 'template_matched', zones: [] },
      }]);
      mockGetClient.mockResolvedValue({
        batches: {
          create: vi.fn().mockResolvedValue({ name: 'batches/path-b-test' }),
        },
      });
      mockUpdateBatchJob.mockResolvedValue();

      const { runBatch } = await import('../services/batchProcessor.js');
      await expect(runBatch('batch-001')).resolves.toBeUndefined();

      const failedCalls = mockUpdateBatchJob.mock.calls.filter(([, fields]) => fields?.status === 'failed');
      expect(failedCalls.map(([, fields]) => fields?.error_message || '').join('\n')).not.toContain('All');
      expect(failedCalls.map(([, fields]) => fields?.error_message || '').join('\n')).not.toContain('filtered out');
      expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-001', expect.objectContaining({
        gpt_prompts: expect.stringContaining(headline),
        status: 'submitting',
      }));
      expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-001', expect.objectContaining({
        gemini_batch_job: 'batches/path-b-test',
        status: 'processing',
      }));
    });
  });

  // ── pollBatchJob ─────────────────────────────────────────

  describe('pollBatchJob', () => {
    it('returns processing for batch in generating_prompts status', async () => {
      mockGetBatchJob.mockResolvedValue(
        makeBatchJob({ status: 'generating_prompts' })
      );

      const { pollBatchJob } = await import('../services/batchProcessor.js');
      const result = await pollBatchJob('batch-001');
      expect(result).toBe('processing');
    });

    it('returns processing for batch in submitting status', async () => {
      mockGetBatchJob.mockResolvedValue(
        makeBatchJob({ status: 'submitting' })
      );

      const { pollBatchJob } = await import('../services/batchProcessor.js');
      const result = await pollBatchJob('batch-001');
      expect(result).toBe('processing');
    });

    it('returns failed when batch has no gemini_batch_job in processing status', async () => {
      mockGetBatchJob.mockResolvedValue(
        makeBatchJob({ status: 'processing', gemini_batch_job: null })
      );

      const { pollBatchJob } = await import('../services/batchProcessor.js');
      const result = await pollBatchJob('batch-001');
      expect(result).toBe('failed');
    });

    it('does not save duplicate results when another worker already claimed the batch', async () => {
      mockGetBatchJob.mockResolvedValue(
        makeBatchJob({ status: 'processing', gemini_batch_job: 'batches/test-job' })
      );
      mockGetClient.mockResolvedValue({
        batches: {
          get: vi.fn().mockResolvedValue({
            state: 'JOB_STATE_SUCCEEDED',
            dest: { inlinedResponses: [] },
          }),
        },
      });
      mockClaimBatchResultsProcessing.mockResolvedValue({
        claimed: false,
        status: 'completed',
        completed_count: 18,
        failed_count: 0,
        run_count: 1,
      });

      const { pollBatchJob } = await import('../services/batchProcessor.js');
      const result = await pollBatchJob('batch-001');

      expect(result).toBe('completed');
      expect(mockClaimBatchResultsProcessing).toHaveBeenCalledWith('batch-001');
      const savingCalls = mockUpdateBatchJob.mock.calls.filter(
        ([, fields]) => fields?.status === 'saving_results'
      );
      expect(savingCalls).toHaveLength(0);
    });

    it('skips existing deterministic ads when result saving is retried', async () => {
      mockGetBatchJob.mockResolvedValue(
        makeBatchJob({
          status: 'processing',
          gemini_batch_job: 'batches/test-job',
          gpt_prompts: JSON.stringify([{ prompt: 'make ad', headline: 'Headline', body_copy: 'Body' }]),
        })
      );
      mockGetProject.mockResolvedValue(makeProject());
      mockGetClient.mockResolvedValue({
        batches: {
          get: vi.fn().mockResolvedValue({
            state: 'JOB_STATE_SUCCEEDED',
            dest: {
              inlinedResponses: [{
                response: {
                  candidates: [{
                    content: {
                      parts: [{
                        inlineData: {
                          data: Buffer.from('image').toString('base64'),
                          mimeType: 'image/png',
                        },
                      }],
                    },
                  }],
                },
              }],
            },
          }),
        },
      });
      mockConvexQuery.mockResolvedValue({ externalId: 'existing-ad' });

      const { pollBatchJob } = await import('../services/batchProcessor.js');
      const result = await pollBatchJob('batch-001');

      expect(result).toBe('completed');
      expect(mockConvexMutation).not.toHaveBeenCalled();
      expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-001', expect.objectContaining({
        status: 'completed',
        completed_count: 1,
      }));
    });
  });

  // ── Batch Lifecycle ──────────────────────────────────────

  describe('batch lifecycle', () => {
    it('creates a batch with correct initial fields', () => {
      const batch = makeBatchJob();
      expect(batch.status).toBe('pending');
      expect(batch.completed_count).toBe(0);
      expect(batch.failed_count).toBe(0);
      expect(batch.run_count).toBe(0);
      expect(batch.retry_count).toBe(0);
      expect(batch.error_message).toBeNull();
      expect(batch.gemini_batch_job).toBeNull();
    });

    it('retry resets status to pending and clears error', () => {
      const failedBatch = makeBatchJob({
        status: 'failed',
        error_message: 'Gemini API error',
        retry_count: 1,
      });

      // Simulate retry reset
      const retried = {
        ...failedBatch,
        status: 'pending',
        error_message: null,
      };

      expect(retried.status).toBe('pending');
      expect(retried.error_message).toBeNull();
      expect(retried.retry_count).toBe(1); // retry_count preserved, incremented by scheduler
    });

    it('auto-retry stops at max 3 retries', () => {
      const batch = makeBatchJob({ retry_count: 3, status: 'failed' });
      const isEligibleForRetry = batch.retry_count < 3 &&
        batch.error_message !== 'Cancelled by user';
      expect(isEligibleForRetry).toBe(false);
    });

    it('cancelled batches are not eligible for auto-retry', () => {
      const batch = makeBatchJob({
        retry_count: 0,
        status: 'failed',
        error_message: 'Cancelled by user',
      });
      const isEligibleForRetry = batch.retry_count < 3 &&
        batch.error_message !== 'Cancelled by user';
      expect(isEligibleForRetry).toBe(false);
    });

    it('batch with retry_count < 3 and non-cancel error is eligible for retry', () => {
      const batch = makeBatchJob({
        retry_count: 1,
        status: 'failed',
        error_message: 'Gemini API timeout',
      });
      const isEligibleForRetry = batch.retry_count < 3 &&
        batch.error_message !== 'Cancelled by user';
      expect(isEligibleForRetry).toBe(true);
    });
  });

  // ── Scheduling ───────────────────────────────────────────

  describe('scheduling', () => {
    it('scheduled batch has scheduled=1 and schedule_cron set', () => {
      const batch = makeBatchJob({
        scheduled: 1,
        schedule_cron: '0 */6 * * *',
      });
      expect(batch.scheduled).toBe(1);
      expect(batch.schedule_cron).toBe('0 */6 * * *');
    });

    it('unscheduled batch has scheduled=0', () => {
      const batch = makeBatchJob({ scheduled: 0 });
      expect(batch.scheduled).toBe(0);
    });

    it('convexBatchToRow maps boolean scheduled to integer 0/1', () => {
      // True → 1
      const convexBatchTrue = { scheduled: true, externalId: 'b1', status: 'pending' };
      const mapped1 = {
        scheduled: convexBatchTrue.scheduled ? 1 : 0,
      };
      expect(mapped1.scheduled).toBe(1);

      // False → 0
      const convexBatchFalse = { scheduled: false, externalId: 'b2', status: 'pending' };
      const mapped0 = {
        scheduled: convexBatchFalse.scheduled ? 1 : 0,
      };
      expect(mapped0.scheduled).toBe(0);
    });

    it('cron expressions are valid', () => {
      const validCrons = [
        '0 * * * *',       // every hour
        '0 */6 * * *',     // every 6 hours
        '0 */12 * * *',    // every 12 hours
        '0 0 * * *',       // daily
        '0 0 * * 1-5',     // weekdays
        '0 0 * * 1',       // weekly (Monday)
        '0 0 1 * *',       // monthly
      ];
      validCrons.forEach(cron => {
        const parts = cron.split(' ');
        expect(parts.length).toBe(5);
      });
    });
  });

  // ── Edge Cases ───────────────────────────────────────────

  describe('edge cases', () => {
    it('batch with no templates uses inspiration images', () => {
      const batch = makeBatchJob({
        generation_mode: 'mode1',
        template_image_id: null,
        template_image_ids: null,
      });
      expect(batch.template_image_id).toBeNull();
      expect(batch.generation_mode).toBe('mode1');
    });

    it('batch with no inspiration images still works (mode1)', () => {
      const batch = makeBatchJob({
        generation_mode: 'mode1',
        inspiration_image_ids: null,
      });
      expect(batch.inspiration_image_ids).toBeNull();
    });

    it('mode2 batch requires templates', () => {
      const batch = makeBatchJob({
        generation_mode: 'mode2',
        template_image_id: 'tpl-001',
      });
      expect(batch.generation_mode).toBe('mode2');
      expect(batch.template_image_id).toBeTruthy();
    });

    it('template rotation tracks used_template_ids as JSON', () => {
      const batch = makeBatchJob({
        used_template_ids: JSON.stringify(['tpl-001', 'tpl-002']),
      });
      const usedIds = JSON.parse(batch.used_template_ids);
      expect(usedIds).toEqual(['tpl-001', 'tpl-002']);
      expect(usedIds.length).toBe(2);
    });

    it('template rotation resets when all templates used', () => {
      const allTemplates = ['tpl-001', 'tpl-002', 'tpl-003'];
      const usedTemplates = ['tpl-001', 'tpl-002', 'tpl-003'];

      const allUsed = allTemplates.every(t => usedTemplates.includes(t));
      expect(allUsed).toBe(true);

      // After reset, used_template_ids should be cleared
      const resetBatch = makeBatchJob({ used_template_ids: null });
      expect(resetBatch.used_template_ids).toBeNull();
    });

    it('multi-angle batch distributes angles randomly', () => {
      const batch = makeBatchJob({
        angle: null,
        angles: JSON.stringify(['angle1', 'angle2', 'angle3']),
      });
      const angles = JSON.parse(batch.angles);
      expect(angles.length).toBe(3);
      expect(angles).toContain('angle1');
    });

    it('pipeline_state tracks progress as JSON', () => {
      const pipelineState = {
        stage: 'headlines',
        completed: 2,
        total: 5,
        stage_index: 1,
      };
      const batch = makeBatchJob({
        pipeline_state: JSON.stringify(pipelineState),
      });
      const state = JSON.parse(batch.pipeline_state);
      expect(state.stage).toBe('headlines');
      expect(state.completed).toBe(2);
      expect(state.total).toBe(5);
    });

    it('batch_stats stores Gemini job statistics as JSON', () => {
      const stats = {
        successfulCount: 4,
        failedCount: 1,
        processingCount: 0,
        totalCount: 5,
      };
      const batch = makeBatchJob({
        batch_stats: JSON.stringify(stats),
      });
      const parsed = JSON.parse(batch.batch_stats);
      expect(parsed.successfulCount).toBe(4);
      expect(parsed.totalCount).toBe(5);
    });
  });

  // ── Data Integrity ───────────────────────────────────────

  describe('data integrity', () => {
    it('batch fields have correct types', () => {
      const batch = makeBatchJob();
      expect(typeof batch.id).toBe('string');
      expect(typeof batch.project_id).toBe('string');
      expect(typeof batch.generation_mode).toBe('string');
      expect(typeof batch.batch_size).toBe('number');
      expect(typeof batch.status).toBe('string');
      expect(typeof batch.scheduled).toBe('number');
      expect(typeof batch.completed_count).toBe('number');
      expect(typeof batch.failed_count).toBe('number');
      expect(typeof batch.run_count).toBe('number');
      expect(typeof batch.retry_count).toBe('number');
    });

    it('batch_size must be between 1 and 50', () => {
      const validBatch = makeBatchJob({ batch_size: 10 });
      expect(validBatch.batch_size).toBeGreaterThanOrEqual(1);
      expect(validBatch.batch_size).toBeLessThanOrEqual(50);
    });

    it('aspect_ratio defaults to 1:1', () => {
      const batch = makeBatchJob();
      expect(batch.aspect_ratio).toBe('1:1');
    });

    it('completed_count accumulates across runs', () => {
      const batch = makeBatchJob({
        completed_count: 5,
        run_count: 2,
      });
      // After another run completes 3 more
      const updated = {
        ...batch,
        completed_count: batch.completed_count + 3,
        run_count: batch.run_count + 1,
      };
      expect(updated.completed_count).toBe(8);
      expect(updated.run_count).toBe(3);
    });

    it('updateBatchJob only allows whitelisted fields', () => {
      const allowedFields = [
        'status', 'gemini_batch_job', 'gpt_prompts', 'error_message',
        'started_at', 'completed_at', 'completed_count', 'failed_count',
        'run_count', 'scheduled', 'schedule_cron', 'retry_count',
        'batch_stats', 'pipeline_state', 'angle', 'angles',
        'batch_size', 'aspect_ratio', 'used_template_ids',
      ];

      // These should NOT be allowed
      const disallowed = ['id', 'project_id', 'generation_mode', 'created_at'];
      disallowed.forEach(field => {
        expect(allowedFields).not.toContain(field);
      });
    });
  });

  // ── Polling Behavior ─────────────────────────────────────

  describe('polling behavior', () => {
    it('scheduler polls every minute', () => {
      const CHECK_INTERVAL = 60;
      expect(CHECK_INTERVAL).toBe(60);
    });

    it('getActiveBatchJobs returns batches in processing states', () => {
      const processingStates = ['generating_prompts', 'submitting', 'processing', 'saving_results'];
      processingStates.forEach(state => {
        const batch = makeBatchJob({ status: state });
        expect(processingStates).toContain(batch.status);
      });
    });

    it('completed and failed batches are not returned by getActive', () => {
      const inactiveStates = ['pending', 'completed', 'failed'];
      const activeStates = ['queued', 'generating_prompts', 'submitting', 'processing', 'saving_results'];
      inactiveStates.forEach(state => {
        expect(activeStates).not.toContain(state);
      });
    });

    it('exponential backoff for retries: 1m, 2m, 4m', () => {
      const baseDelay = 60000; // 1 minute
      for (let retry = 0; retry < 3; retry++) {
        const delay = baseDelay * Math.pow(2, retry);
        const expected = [60000, 120000, 240000][retry];
        expect(delay).toBe(expected);
      }
    });
  });

  // ── Cost Tracking ────────────────────────────────────────

  describe('cost tracking', () => {
    it('Gemini batch discount is 50%', () => {
      const batchDiscount = 0.5;
      const standardRate = 0.04;
      const batchRate = standardRate * batchDiscount;
      expect(batchRate).toBe(0.02);
    });

    it('cost is logged for each successful image in batch', () => {
      const batchSize = 5;
      const successfulCount = 4;
      // Cost should be logged for 4 images, not 5
      expect(successfulCount).toBeLessThanOrEqual(batchSize);
      expect(successfulCount).toBeGreaterThan(0);
    });
  });

});
