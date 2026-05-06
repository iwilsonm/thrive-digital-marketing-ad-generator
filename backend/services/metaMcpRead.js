import Anthropic from '@anthropic-ai/sdk';
import { logAnthropicCost } from './costTracker.js';
import { MCPNotAuthorizedError } from './metaMcp.js';

const META_MCP_URL = 'https://mcp.facebook.com/ads';
const MCP_BETA_HEADER = 'mcp-client-2025-11-20';
const MCP_TOOLSET_NAME = 'meta-ads';
const MCP_MODEL = 'claude-sonnet-4-6';

export class MCPReadUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MCPReadUnavailableError';
    this.code = 'MCP_READ_UNAVAILABLE';
    this.status = 424;
  }
}

function buildDateDescription(opts = {}) {
  if (opts.dateFrom && opts.dateTo) {
    return `custom date range ${opts.dateFrom} through ${opts.dateTo}`;
  }
  if (opts.datePreset === 'lifetime') return 'maximum/lifetime date preset';
  return `date preset ${opts.datePreset || 'last_7d'}`;
}

function numberish(value, fallback = 0) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMetricFields(row) {
  return {
    ...row,
    impressions: numberish(row.impressions),
    clicks: numberish(row.clicks),
    spend: numberish(row.spend),
    reach: numberish(row.reach),
    frequency: numberish(row.frequency),
    ctr: numberish(row.ctr),
    cpm: numberish(row.cpm),
    cpc: numberish(row.cpc),
    cpp: numberish(row.cpp),
    social_spend: numberish(row.social_spend),
    inline_link_clicks: numberish(row.inline_link_clicks),
    inline_link_click_ctr: numberish(row.inline_link_click_ctr),
    purchase_count: numberish(row.purchase_count),
    purchase_value: numberish(row.purchase_value),
    cost_per_purchase: numberish(row.cost_per_purchase),
    purchase_roas: Array.isArray(row.purchase_roas) ? row.purchase_roas : [],
    website_purchase_roas: Array.isArray(row.website_purchase_roas) ? row.website_purchase_roas : [],
    mobile_app_purchase_roas: Array.isArray(row.mobile_app_purchase_roas) ? row.mobile_app_purchase_roas : [],
    actions: Array.isArray(row.actions) ? row.actions : [],
    action_values: Array.isArray(row.action_values) ? row.action_values : [],
    cost_per_action_type: Array.isArray(row.cost_per_action_type) ? row.cost_per_action_type : [],
  };
}

function normalizeRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id)
    .map((row) => normalizeMetricFields(row));
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (!objectMatch) throw new MCPReadUnavailableError(`Meta MCP read did not return JSON. Output: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(objectMatch[0]);
  } catch (err) {
    throw new MCPReadUnavailableError(`Meta MCP read JSON parse failed: ${err.message}. Output: ${text.slice(0, 400)}`);
  }
}

function inspectToolErrors(blocks) {
  const toolResults = blocks.filter((b) => b.type === 'mcp_tool_result');
  const errored = toolResults.filter((r) => r.is_error);
  if (errored.length === 0) return;
  const first = JSON.stringify(errored[0].content || []).slice(0, 500);
  if (/authoriz|restricted|401|Unauthorized/i.test(first)) {
    throw new MCPNotAuthorizedError(`Meta MCP rejected read calls. Details: ${first}`);
  }
  if (/not found|unknown tool|unsupported|permission|scope/i.test(first)) {
    throw new MCPReadUnavailableError(`Meta MCP reads are not available for this account/app. Details: ${first}`);
  }
  throw new MCPReadUnavailableError(`Meta MCP read tool error: ${first}`);
}

async function runMcpRead({
  anthropicApiKey,
  metaToken,
  accountId,
  operation,
  opts = {},
  projectId = null,
}) {
  if (!anthropicApiKey) throw new MCPReadUnavailableError('Anthropic API key is required for Meta MCP reads.');
  if (!metaToken) throw new MCPReadUnavailableError('Meta token is required for Meta MCP reads.');
  if (!accountId) throw new MCPReadUnavailableError('Meta ad account is required for Meta MCP reads.');

  const client = new Anthropic({ apiKey: anthropicApiKey });
  const scopeLines = [
    `- Ad account: ${accountId}`,
    `- Date window: ${buildDateDescription(opts)}`,
  ];
  if (opts.campaignId) scopeLines.push(`- Campaign filter: ${opts.campaignId}`);
  if (opts.adsetId) scopeLines.push(`- Ad set filter: ${opts.adsetId}`);

  const prompt = `Use the Meta Ads MCP server to read Meta ads data for Thrive Campaigns.

Return ONLY a JSON object. Do not include prose or markdown.

Operation: ${operation}
${scopeLines.join('\n')}

Required output shape:
{
  "rows": [
    {
      "id": "Meta object id",
      "name": "Name",
      "status": "configured status if available",
      "effective_status": "effective status if available",
      "created_time": "ISO/meta timestamp if available",
      "updated_time": "ISO/meta timestamp if available",
      "campaign_id": "campaign id if relevant",
      "campaign_name": "campaign name if relevant",
      "adset_id": "ad set id if relevant",
      "adset_name": "ad set name if relevant",
      "objective": "campaign objective if relevant",
      "daily_budget": "budget if available",
      "lifetime_budget": "budget if available",
      "impressions": 0,
      "clicks": 0,
      "spend": 0,
      "reach": 0,
      "frequency": 0,
      "ctr": 0,
      "cpm": 0,
      "cpc": 0,
      "cpp": 0,
      "inline_link_clicks": 0,
      "purchase_count": 0,
      "purchase_value": 0,
      "cost_per_purchase": 0,
      "purchase_roas": [],
      "actions": [],
      "action_values": [],
      "cost_per_action_type": [],
      "thumbnail_url": "ad thumbnail URL if relevant"
    }
  ]
}

Rules:
- Use Meta MCP tools only.
- Read no more than 200 rows.
- Include performance metrics for the requested date window when the MCP tools expose them.
- If an insight metric is unavailable, use 0 or [].
- If this operation is not supported by available MCP tools, return {"rows": [], "error": "unsupported_mcp_read"} instead of guessing.`;

  let response;
  try {
    response = await client.beta.messages.create({
      model: MCP_MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
      mcp_servers: [
        {
          type: 'url',
          url: META_MCP_URL,
          name: MCP_TOOLSET_NAME,
          authorization_token: metaToken,
        },
      ],
      tools: [
        {
          type: 'mcp_toolset',
          mcp_server_name: MCP_TOOLSET_NAME,
          default_config: { enabled: true },
        },
      ],
      betas: [MCP_BETA_HEADER],
    });
  } catch (err) {
    throw new MCPReadUnavailableError(`Anthropic MCP read call failed: ${err.message}`);
  }

  try {
    logAnthropicCost({
      model: MCP_MODEL,
      inputTokens: response?.usage?.input_tokens || 0,
      outputTokens: response?.usage?.output_tokens || 0,
      operation: `meta_mcp_read_${operation}`,
      projectId,
    }).catch(() => {});
  } catch {}

  const blocks = Array.isArray(response.content) ? response.content : [];
  inspectToolErrors(blocks);
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim();
  const parsed = extractJson(text);
  if (parsed?.error) {
    throw new MCPReadUnavailableError('Meta MCP reads are not available for this account/app. Switch Read Path to API or request MCP read access.');
  }
  return normalizeRows(parsed?.rows);
}

export async function getCampaignsWithInsightsViaMcp(args) {
  return await runMcpRead({ ...args, operation: 'list campaigns with insights' });
}

export async function getAdSetsWithInsightsViaMcp(args) {
  return await runMcpRead({ ...args, operation: 'list ad sets with insights' });
}

export async function getAdsWithInsightsViaMcp(args) {
  return await runMcpRead({ ...args, operation: 'list ads with insights' });
}

export async function checkMetaMcpReadAccess(args) {
  await runMcpRead({
    ...args,
    operation: 'check account-level MCP read access by listing up to one campaign',
    opts: { ...(args?.opts || {}), datePreset: args?.opts?.datePreset || 'last_7d' },
  });
  return true;
}
