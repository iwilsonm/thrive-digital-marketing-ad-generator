/**
 * Global rate limiters for LLM and image generation API calls.
 *
 * Heavy LLM limiter: Each ad generation uses ~350K tokens across 3 GPT-5.2
 * calls. With a 500K TPM limit, 2 concurrent generations blow past the limit.
 * Also used for heavy Claude Opus/Sonnet calls in the batch pipeline.
 *
 * Gemini limiter: Caps concurrent image generation requests to avoid
 * overwhelming the Gemini API and triggering 429s.
 *
 * Lighter calls (GPT-4.1-mini, headline extraction, etc.) are not limited.
 */

export class AsyncSemaphore {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    // Wait in queue
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next();
    }
  }

  /**
   * Run a function with the semaphore acquired.
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get pending() {
    return this.queue.length;
  }

  get active() {
    return this.running;
  }
}

// ── Heavy LLM semaphore (GPT-5.2 + Claude Opus/Sonnet) ──────────────────────

// Allow 2 concurrent heavy LLM calls.
// Each ad uses ~350K tokens across 3 sequential GPT-5.2 calls.
// With 500K TPM limit, 2 concurrent ads work because the 3 calls within each
// ad are sequential (not all 350K at once), so the actual concurrent token
// usage stays under the limit. The retry logic handles any occasional 429s.
const heavyLLMSemaphore = new AsyncSemaphore(2);

// Minimum gap between heavy LLM calls (ms) to let the TPM window slide
const MIN_GAP_MS = 2000;
let lastHeavyCallEnd = 0;

/**
 * Execute a heavy LLM call (GPT-5.2, Claude Opus/Sonnet) with global rate limiting.
 * Up to 2 heavy calls run concurrently, with a minimum gap between new calls.
 *
 * @param {() => Promise<T>} fn - The async function to run
 * @param {string} [label] - Label for logging
 * @returns {Promise<T>}
 */
export async function withHeavyLLMLimit(fn, label = '') {
  const queuePos = heavyLLMSemaphore.pending;
  if (queuePos > 0) {
    console.log(`[LLMLimit] ${label} Queued (position ${queuePos}, ${heavyLLMSemaphore.active} active)`);
  }

  return heavyLLMSemaphore.run(async () => {
    // Enforce minimum gap between heavy calls
    const elapsed = Date.now() - lastHeavyCallEnd;
    if (elapsed < MIN_GAP_MS && lastHeavyCallEnd > 0) {
      const waitMs = MIN_GAP_MS - elapsed;
      console.log(`[LLMLimit] ${label} Waiting ${Math.round(waitMs / 1000)}s gap before next call...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    console.log(`[LLMLimit] ${label} Starting heavy LLM call...`);
    try {
      const result = await fn();
      return result;
    } finally {
      lastHeavyCallEnd = Date.now();
      console.log(`[LLMLimit] ${label} Done. ${heavyLLMSemaphore.pending} waiting in queue.`);
    }
  });
}

// Backward-compatible alias
export { withHeavyLLMLimit as withGptRateLimit };

// ── Gemini image generation semaphore ────────────────────────────────────────

// Allow 3 concurrent Gemini image generation calls.
const geminiSemaphore = new AsyncSemaphore(3);

/**
 * Execute a Gemini image generation call with concurrency limiting.
 * Up to 3 image generations run concurrently.
 *
 * @param {() => Promise<T>} fn - The async function to run
 * @param {string} [label] - Label for logging
 * @returns {Promise<T>}
 */
export async function withGeminiLimit(fn, label = '') {
  const queuePos = geminiSemaphore.pending;
  const queueDepthAtStart = geminiSemaphore.active + geminiSemaphore.pending;
  if (queuePos > 0) {
    console.log(`[GeminiLimit] ${label} Queued (position ${queuePos}, ${geminiSemaphore.active} active)`);
  }

  return geminiSemaphore.run(async () => {
    console.log(`[GeminiLimit] ${label} Starting image generation...`);
    try {
      const result = await fn({ queueDepthAtStart });
      return result;
    } finally {
      console.log(`[GeminiLimit] ${label} Done. ${geminiSemaphore.pending} waiting.`);
    }
  });
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Get current rate limiter stats (for debugging/monitoring via /api/health).
 */
export function getRateLimiterStats() {
  return {
    activeHeavyCalls: heavyLLMSemaphore.active,
    queuedHeavyCalls: heavyLLMSemaphore.pending,
    lastHeavyCallEnd: lastHeavyCallEnd ? new Date(lastHeavyCallEnd).toISOString() : null,
    activeGeminiCalls: geminiSemaphore.active,
    queuedGeminiCalls: geminiSemaphore.pending,
  };
}
