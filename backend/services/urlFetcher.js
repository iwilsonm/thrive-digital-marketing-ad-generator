// URL fetcher for the "Sales Page from URL" feature.
//
// Threat model: authenticated staff paste a URL to a real sales page. We fetch
// the page, extract readable text, and return structured diagnostics when a URL
// cannot be read automatically.
//
import * as cheerio from 'cheerio';
import dns from 'dns/promises';
import net from 'net';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^\[?::1\]?$/, /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd/i,
];

const MAX_EXTRACTED_CHARS = 50_000;
const MIN_USEFUL_TEXT_CHARS = 80;
const DEFAULT_MANUAL_RECOVERY_STEPS = [
  'Open the sales page in your browser.',
  'Press Cmd+P on Mac or Ctrl+P on Windows.',
  'Choose Save as PDF.',
  'Upload that PDF here using the Upload option.',
  'Or copy the page text and use Paste instead.',
];

const ERROR_MESSAGES = {
  invalid_url: 'Only http/https URLs are allowed.',
  private_url: 'This URL is blocked because it points to a private or local network address.',
  upstream_forbidden: 'The website blocked our request. It may require login, a captcha, or anti-bot approval.',
  upstream_not_found: 'The page returned 404 Not Found.',
  upstream_error: 'The website returned an error before we could read it.',
  response_too_large: 'This page or file is too large to fetch automatically.',
  unsupported_content_type: 'This link points to a file type we cannot read as sales page text.',
  unsupported_media: 'This link points to media instead of a readable sales page.',
  scanned_pdf: 'We found a PDF, but it does not contain readable text. It may be scanned or image-only.',
  browser_unavailable: 'This page appears to need browser rendering, but the browser fallback could not run.',
  unreadable_page: 'We could not extract readable text from this page after trying automatic methods.',
  network_error: 'We could not reach this URL.',
};

export class UrlFetchError extends Error {
  constructor(reasonCode, message, options = {}) {
    super(message || ERROR_MESSAGES[reasonCode] || 'Failed to fetch URL');
    this.name = 'UrlFetchError';
    this.reason_code = reasonCode;
    this.reasonCode = reasonCode;
    this.user_message = this.message;
    this.attempted_methods = options.attemptedMethods || [];
    this.manual_recovery_steps = options.manualRecoverySteps || DEFAULT_MANUAL_RECOVERY_STEPS;
    this.details = options.details || null;
    this.status = options.status || 400;
    if (options.cause) this.cause = options.cause;
  }
}

function makeFetchError(reasonCode, options = {}) {
  return new UrlFetchError(reasonCode, options.message || ERROR_MESSAGES[reasonCode], options);
}

function isPrivateIp(address) {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    const parts = address.split('.').map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (ipVersion === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      return isPrivateIp(lower.replace('::ffff:', ''));
    }
    return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

async function assertSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw makeFetchError('invalid_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw makeFetchError('invalid_url');
  }
  if (BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(url.hostname))) {
    throw makeFetchError('private_url');
  }
  const directIp = net.isIP(url.hostname) ? url.hostname : null;
  let addresses = [];
  try {
    addresses = directIp
      ? [{ address: directIp }]
      : await dns.lookup(url.hostname, { all: true, verbatim: false });
  } catch (err) {
    throw makeFetchError('network_error', { cause: err, details: err.message });
  }
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw makeFetchError('private_url');
  }
  return url;
}

// Return a safe-for-logs version of the URL: strips userinfo + query string.
export function safeUrlForLogs(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function truncateText(text) {
  const truncated = text.length > MAX_EXTRACTED_CHARS;
  return {
    text: truncated ? text.slice(0, MAX_EXTRACTED_CHARS) : text,
    truncated,
  };
}

function extensionFromUrl(urlString = '') {
  try {
    const pathname = new URL(urlString).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/);
    return match ? `.${match[1]}` : '';
  } catch {
    return '';
  }
}

function isHtmlContent(contentType, ext) {
  return (
    !contentType ||
    contentType.includes('text/html') ||
    contentType.includes('application/xhtml') ||
    ext === '.html' ||
    ext === '.htm'
  );
}

function isPdfContent(contentType, ext) {
  return contentType.includes('application/pdf') || ext === '.pdf';
}

function isTextContent(contentType, ext) {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('application/xml') ||
    contentType.includes('application/ld+json') ||
    contentType.includes('application/rtf') ||
    ['.txt', '.md', '.csv', '.json', '.xml', '.rtf'].includes(ext)
  );
}

function isMediaContent(contentType, ext) {
  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('audio/') ||
    ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.mp4', '.mov', '.mp3'].includes(ext)
  );
}

function extractJsonLdText(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => extractJsonLdText(item, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const key of ['name', 'headline', 'description', 'text', 'articleBody', 'about']) {
      if (typeof value[key] === 'string') out.push(value[key]);
    }
    for (const nestedKey of ['mainEntity', 'offers', 'review', 'aggregateRating', 'brand']) {
      extractJsonLdText(value[nestedKey], out);
    }
  }
  return out;
}

function extractHtmlText(html) {
  const $ = cheerio.load(html);
  const title = normalizeText($('title').first().text()) || null;
  const metaParts = [
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:title"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('meta[name="twitter:title"]').attr('content'),
    $('meta[name="twitter:description"]').attr('content'),
  ].map(normalizeText).filter(Boolean);

  const jsonLdParts = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).text());
      extractJsonLdText(parsed, jsonLdParts);
    } catch {}
  });

  const scriptCount = $('script[src], script:not([type]), script[type="module"], script[type="text/javascript"]').length;
  const appRootCount = $('[id="root"], [id="app"], [data-reactroot], [ng-app]').length;

  $('script, style, noscript, iframe, svg, nav, header, footer, aside').remove();

  const candidates = ['main', 'article', '[role="main"]', '#content', '.content', 'body'];
  let text = '';
  for (const sel of candidates) {
    const extracted = normalizeText($(sel).first().text());
    if (extracted.length > text.length) text = extracted;
    if (text.length > 500) break;
  }

  const supportingText = normalizeText([...metaParts, ...jsonLdParts].join(' '));
  const combinedText = normalizeText([text, supportingText].filter(Boolean).join(' '));

  return {
    text: combinedText,
    title,
    scriptCount,
    appRootCount,
    likelyJsShell: scriptCount > 0 && appRootCount > 0 && text.length < MIN_USEFUL_TEXT_CHARS,
  };
}

async function extractPdfText(buffer, attemptedMethods, pdfParser = pdf) {
  attemptedMethods.push('file_parse');
  let data;
  try {
    data = await pdfParser(buffer);
  } catch (err) {
    throw makeFetchError('unsupported_content_type', {
      attemptedMethods,
      cause: err,
      details: `PDF parse failed: ${err.message}`,
    });
  }
  const text = normalizeText(data.text || '');
  if (!text) {
    throw makeFetchError('scanned_pdf', { attemptedMethods });
  }
  return truncateText(text);
}

async function renderUrlWithBrowser(urlString, { timeoutMs = 20_000 } = {}) {
  await assertSafeUrl(urlString);

  let browser;
  try {
    let chromiumLauncher;
    let launchOptions = { headless: true };

    if (process.env.VERCEL || process.env.AWS_EXECUTION_ENV || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      const [{ chromium }, chromiumPackage] = await Promise.all([
        import('playwright-core'),
        import('@sparticuz/chromium'),
      ]);
      const chromiumConfig = chromiumPackage.default || chromiumPackage;
      chromiumLauncher = chromium;
      launchOptions = {
        args: chromiumConfig.args,
        defaultViewport: chromiumConfig.defaultViewport,
        executablePath: await chromiumConfig.executablePath(),
        headless: chromiumConfig.headless,
      };
    } else {
      try {
        const { chromium } = await import('playwright');
        chromiumLauncher = chromium;
      } catch {
        const { chromium } = await import('playwright-core');
        chromiumLauncher = chromium;
      }
    }

    browser = await chromiumLauncher.launch(launchOptions);
    const context = await browser.newContext({
      userAgent: 'ThriveDigitalMarketingBot/1.0 (+https://thrive-digital-marketing-ad-generat.vercel.app)',
    });
    const page = await context.newPage();

    await page.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      if (['media', 'font'].includes(resourceType)) return route.abort();
      try {
        await assertSafeUrl(requestUrl);
        return route.continue();
      } catch {
        return route.abort();
      }
    });

    await page.goto(urlString, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 18_000) });
    await assertSafeUrl(page.url());
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(750);

    const result = await page.evaluate(() => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || '';
      const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map((node) => node.textContent || '')
        .join(' ');
      return {
        text: normalize([
          document.body?.innerText || '',
          meta('meta[name="description"]'),
          meta('meta[property="og:title"]'),
          meta('meta[property="og:description"]'),
          jsonLd,
        ].filter(Boolean).join(' ')),
        title: normalize(document.title),
        finalUrl: window.location.href,
      };
    });

    await assertSafeUrl(result.finalUrl);
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function readBoundedResponse(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw makeFetchError('response_too_large');
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) {
    throw makeFetchError('response_too_large');
  }
  return buf;
}

function classifyHttpError(status, attemptedMethods) {
  if (status === 401 || status === 403) {
    return makeFetchError('upstream_forbidden', { attemptedMethods, details: `HTTP ${status}` });
  }
  if (status === 404) {
    return makeFetchError('upstream_not_found', { attemptedMethods, details: 'HTTP 404' });
  }
  return makeFetchError('upstream_error', { attemptedMethods, details: `HTTP ${status}` });
}

export async function fetchUrlText(
  urlString,
  {
    maxBytes = 2_000_000,
    timeoutMs = 15_000,
    browserTimeoutMs = 20_000,
    browserRenderer = renderUrlWithBrowser,
    pdfParser = pdf,
  } = {}
) {
  const attemptedMethods = [];
  await assertSafeUrl(urlString);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    attemptedMethods.push('static_fetch');
    const res = await fetch(urlString, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'ThriveDigitalMarketingBot/1.0 (+https://thrive-digital-marketing-ad-generat.vercel.app)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.85,text/plain;q=0.8,*/*;q=0.5',
      },
    });

    if (!res.ok) throw classifyHttpError(res.status, attemptedMethods);

    await assertSafeUrl(res.url);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const ext = extensionFromUrl(res.url || urlString);
    const buffer = await readBoundedResponse(res, maxBytes);

    if (isPdfContent(contentType, ext)) {
      const { text, truncated } = await extractPdfText(buffer, attemptedMethods, pdfParser);
      return {
        text,
        title: null,
        truncated,
        sparse: text.length < 200,
        sourceHost: new URL(res.url).hostname,
        extraction_method: 'file_parse',
        attempted_methods: attemptedMethods,
      };
    }

    if (isMediaContent(contentType, ext)) {
      throw makeFetchError('unsupported_media', { attemptedMethods, details: contentType || ext });
    }

    if (!isHtmlContent(contentType, ext) && !isTextContent(contentType, ext)) {
      throw makeFetchError('unsupported_content_type', { attemptedMethods, details: contentType || ext || 'unknown' });
    }

    const body = buffer.toString('utf8');

    if (!isHtmlContent(contentType, ext)) {
      const rawText = normalizeText(body);
      if (!rawText) throw makeFetchError('unreadable_page', { attemptedMethods });
      const { text, truncated } = truncateText(rawText);
      return {
        text,
        title: null,
        truncated,
        sparse: text.length < 200,
        sourceHost: new URL(res.url).hostname,
        extraction_method: 'text_parse',
        attempted_methods: attemptedMethods,
      };
    }

    const htmlResult = extractHtmlText(body);
    const shouldTryBrowser = htmlResult.likelyJsShell || htmlResult.text.length < MIN_USEFUL_TEXT_CHARS;
    if (!shouldTryBrowser && htmlResult.text) {
      const { text, truncated } = truncateText(htmlResult.text);
      return {
        text,
        title: htmlResult.title,
        truncated,
        sparse: text.length < 200,
        sourceHost: new URL(res.url).hostname,
        extraction_method: 'static_fetch',
        attempted_methods: attemptedMethods,
      };
    }

    let browserError = null;
    attemptedMethods.push('browser_render');
    try {
      const rendered = await browserRenderer(res.url || urlString, { timeoutMs: browserTimeoutMs });
      const renderedText = normalizeText(rendered?.text || '');
      if (renderedText.length >= MIN_USEFUL_TEXT_CHARS) {
        const { text, truncated } = truncateText(renderedText);
        return {
          text,
          title: rendered.title || htmlResult.title,
          truncated,
          sparse: text.length < 200,
          sourceHost: new URL(rendered.finalUrl || res.url).hostname,
          extraction_method: 'browser_render',
          attempted_methods: attemptedMethods,
        };
      }
    } catch (err) {
      browserError = err;
    }

    if (htmlResult.text && htmlResult.text.length >= MIN_USEFUL_TEXT_CHARS) {
      const { text, truncated } = truncateText(htmlResult.text);
      return {
        text,
        title: htmlResult.title,
        truncated,
        sparse: true,
        sourceHost: new URL(res.url).hostname,
        extraction_method: 'static_fetch',
        attempted_methods: attemptedMethods,
      };
    }

    if (browserError) {
      throw makeFetchError('browser_unavailable', {
        attemptedMethods,
        cause: browserError,
        details: browserError.message,
      });
    }
    throw makeFetchError('unreadable_page', { attemptedMethods });
  } catch (err) {
    if (err instanceof UrlFetchError) {
      if (!err.attempted_methods?.length) err.attempted_methods = attemptedMethods;
      throw err;
    }
    if (err?.name === 'AbortError') {
      throw makeFetchError('network_error', { attemptedMethods, cause: err, details: 'Request timed out' });
    }
    throw makeFetchError('network_error', { attemptedMethods, cause: err, details: err.message });
  } finally {
    clearTimeout(timer);
  }
}
