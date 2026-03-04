const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { deduplicateRecords, enrichWithUsage } = require('../src/parsers/anthropic-api');

function makeCostResult(overrides = {}) {
  return {
    currency: 'USD',
    amount: '12.50',
    workspace_id: 'wrkspc_01abc',
    model: 'claude-sonnet-4-20250514',
    description: 'Claude Sonnet 4 Usage - Input Tokens',
    cost_type: 'tokens',
    token_type: 'uncached_input_tokens',
    ...overrides,
  };
}

function makeCostDayBucket(results, date = '2026-02-15T00:00:00Z') {
  return {
    starting_at: date,
    ending_at: date.replace(/T.*/, 'T00:00:00Z'),
    results: Array.isArray(results) ? results : [results],
  };
}

function makeUsageResult(overrides = {}) {
  return {
    uncached_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
    cache_read_input_tokens: 300,
    output_tokens: 500,
    server_tool_use: { web_search_requests: 0 },
    model: 'claude-sonnet-4-20250514',
    workspace_id: 'wrkspc_01abc',
    context_window: '0-200k',
    inference_geo: 'us',
    service_tier: 'standard',
    ...overrides,
  };
}

function makeUsageDayBucket(results, date = '2026-02-15T00:00:00Z') {
  return {
    starting_at: date,
    ending_at: date.replace(/T.*/, 'T00:00:00Z'),
    results: Array.isArray(results) ? results : [results],
  };
}

const FAKE_API_KEYS = [
  { id: 'apikey_01AAA', name: 'My Pipeline Key' },
  { id: 'apikey_01BBB', name: 'Cursor Key' },
];

function buildMockFetch({ costPages = [[]], apiKeys = FAKE_API_KEYS, usagePages = null, usagePerKey = {} } = {}) {
  let costIdx = 0;
  let usageIdx = 0;

  const costResponses = costPages.map((data, i) => ({
    data,
    has_more: i < costPages.length - 1,
    next_page: i < costPages.length - 1 ? `page_${i + 1}` : undefined,
  }));

  const usageResponses = usagePages ? usagePages.map((data, i) => ({
    data,
    has_more: i < usagePages.length - 1,
    next_page: i < usagePages.length - 1 ? `upage_${i + 1}` : undefined,
  })) : null;

  return mock.fn((url) => {
    const urlStr = typeof url === 'string' ? url : '';

    if (urlStr.includes('/api_keys')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: apiKeys, has_more: false }),
      });
    }

    if (urlStr.includes('/cost_report')) {
      const body = costResponses[costIdx++] || { data: [], has_more: false };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }

    if (urlStr.includes('/usage_report/messages')) {
      for (const [keyId, response] of Object.entries(usagePerKey)) {
        if (urlStr.includes(encodeURIComponent(keyId))) {
          if (response instanceof Error) return Promise.reject(response);
          if (response.status && !response.ok) return Promise.resolve(response);
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(response),
          });
        }
      }

      if (usageResponses) {
        const body = usageResponses[usageIdx++] || { data: [], has_more: false };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }

      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ data: [], has_more: false }),
      });
    }

    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [], has_more: false }) });
  });
}

describe('Anthropic API fetcher', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty when no keys provided', async () => {
    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi([], 30);
    assert.equal(result.records.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.keyTotals.length, 0);
  });

  it('builds cost-only records when usage is unavailable', async () => {
    const costPage = [makeCostDayBucket(makeCostResult())];
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    globalThis.fetch = mock.fn((url) => {
      const urlStr = typeof url === 'string' ? url : '';
      if (urlStr.includes('/api_keys')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [], has_more: false }) });
      }
      if (urlStr.includes('/cost_report')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: costPage, has_more: false }) });
      }
      if (urlStr.includes('/usage_report')) {
        return Promise.reject(abortErr);
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [], has_more: false }) });
    });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 7);

    assert.ok(result.records.length >= 1, 'cost records present despite usage timeout');
    const r = result.records[0];
    assert.equal(r.provider, 'anthropic-api');
    assert.equal(r.cost, 0.125);
    assert.equal(r.inputTokens, 0, 'no tokens when usage unavailable');
    assert.ok(result.warnings.some(w => w.includes('usage data unavailable')));
  });

  it('enriches cost records with token data when usage succeeds', async () => {
    const costPage = [makeCostDayBucket(makeCostResult())];
    const usagePage = [makeUsageDayBucket(makeUsageResult())];
    globalThis.fetch = buildMockFetch({
      costPages: [costPage],
      usagePages: [usagePage],
      apiKeys: [],
    });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 7);

    assert.ok(result.records.length >= 1);
    const r = result.records[0];
    assert.equal(r.cost, 0.125, 'cost from cost report');
    assert.equal(r.inputTokens, 1000, 'tokens from usage report');
    assert.equal(r.outputTokens, 500);
    assert.equal(r.cacheRead, 300);
    assert.equal(r.cacheWrite, 200);
  });

  it('returns keyTotals from per-key usage', async () => {
    const costPage = [makeCostDayBucket(makeCostResult())];
    globalThis.fetch = buildMockFetch({
      costPages: [costPage],
      usagePerKey: {
        'apikey_01AAA': { data: [makeUsageDayBucket(makeUsageResult())], has_more: false },
        'apikey_01BBB': { data: [makeUsageDayBucket(makeUsageResult({ uncached_input_tokens: 2000, output_tokens: 800 }))], has_more: false },
      },
    });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 7);

    assert.equal(result.keyTotals.length, 2);
    const k1 = result.keyTotals.find(k => k.key === 'My Pipeline Key');
    assert.ok(k1);
    assert.equal(k1.inputTokens, 1000);
    const k2 = result.keyTotals.find(k => k.key === 'Cursor Key');
    assert.ok(k2);
    assert.equal(k2.inputTokens, 2000);
  });

  it('per-key timeout produces warning but does not break records', async () => {
    const costPage = [makeCostDayBucket(makeCostResult())];
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    globalThis.fetch = buildMockFetch({
      costPages: [costPage],
      usagePerKey: {
        'apikey_01AAA': abortErr,
        'apikey_01BBB': abortErr,
      },
    });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 7);

    assert.ok(result.records.length >= 1, 'cost records still present');
    assert.ok(result.warnings.some(w => w.includes('unavailable')));
    assert.equal(result.keyTotals.length, 0);
  });

  it('warns on 401 auth failure and continues', async () => {
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'unauthorized' }) })
    );

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-bad-key-1234567890'], 7);

    assert.equal(result.records.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings.some(w => w.includes('authentication failed')));
  });

  it('warns on 404 for individual accounts', async () => {
    globalThis.fetch = mock.fn(() =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) })
    );

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-ind-key-1234567890'], 7);

    assert.equal(result.records.length, 0);
    assert.ok(result.warnings.some(w => w.includes('individual accounts')));
  });

  it('sums multiple cost line items for the same day/model', async () => {
    const costPage = [makeCostDayBucket([
      makeCostResult({ amount: '300', token_type: 'uncached_input_tokens' }),
      makeCostResult({ amount: '500', token_type: 'output_tokens' }),
    ])];
    globalThis.fetch = buildMockFetch({ costPages: [costPage], apiKeys: [] });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 7);

    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].cost, 8.0);
  });

  it('handles empty date range gracefully', async () => {
    globalThis.fetch = buildMockFetch({ costPages: [[]], apiKeys: [] });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 1);

    assert.equal(result.records.length, 0);
    assert.equal(result.warnings.length, 0);
  });

  it('handles cost report pagination', async () => {
    const page1 = [makeCostDayBucket(makeCostResult(), '2026-02-14T00:00:00Z')];
    const page2 = [makeCostDayBucket(makeCostResult({ model: 'claude-opus-4-20250514', description: 'Claude Opus 4 Usage', amount: '50.00' }), '2026-02-15T00:00:00Z')];

    globalThis.fetch = buildMockFetch({ costPages: [page1, page2], apiKeys: [] });

    const { fetchAnthropicApi } = require('../src/parsers/anthropic-api');
    const result = await fetchAnthropicApi(['sk-ant-admin-test-key-123456789'], 7);

    assert.equal(result.records.length, 2);
  });
});

describe('enrichWithUsage', () => {
  it('enriches matching cost records with token data', () => {
    const costRecords = [{
      provider: 'anthropic-api',
      date: '2026-02-15T00:00:00.000Z',
      model: 'claude-sonnet-4-20250514',
      workspace: 'wrkspc_01abc',
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0,
      cost: 0.125,
    }];
    const usageBuckets = [{
      bucket_start_time: '2026-02-15T00:00:00Z',
      model: 'claude-sonnet-4-20250514',
      workspace_id: 'wrkspc_01abc',
      uncached_input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
      server_tool_use: { web_search_requests: 0 },
    }];

    enrichWithUsage(costRecords, usageBuckets, []);
    assert.equal(costRecords[0].inputTokens, 1000);
    assert.equal(costRecords[0].outputTokens, 500);
    assert.equal(costRecords[0].cacheRead, 300);
    assert.equal(costRecords[0].cacheWrite, 200);
    assert.equal(costRecords[0].cost, 0.125, 'cost unchanged');
  });

  it('adds usage-only records to allRecords when no cost match', () => {
    const costRecords = [];
    const allRecords = [];
    const usageBuckets = [{
      bucket_start_time: '2026-02-15T00:00:00Z',
      model: 'claude-sonnet-4-20250514',
      workspace_id: null,
      uncached_input_tokens: 500,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      server_tool_use: { web_search_requests: 0 },
    }];

    enrichWithUsage(costRecords, usageBuckets, allRecords);
    assert.equal(costRecords.length, 0);
    assert.equal(allRecords.length, 1);
    assert.equal(allRecords[0].inputTokens, 500);
    assert.ok(allRecords[0].cost > 0, 'estimated cost for usage-only record');
  });

  it('does nothing when usageBuckets is empty', () => {
    const costRecords = [{ date: '2026-02-15T00:00:00.000Z', model: 'x', workspace: null, inputTokens: 0 }];
    enrichWithUsage(costRecords, [], []);
    assert.equal(costRecords[0].inputTokens, 0);
  });
});

describe('Deduplication', () => {
  it('merges cost and keeps max tokens for same date/model/workspace', () => {
    const records = [
      { date: '2026-02-15T00:00:00.000Z', model: 'claude-sonnet-4-20250514', workspace: 'w1', inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0.10 },
      { date: '2026-02-15T00:00:00.000Z', model: 'claude-sonnet-4-20250514', workspace: 'w1', inputTokens: 1000, outputTokens: 500, cacheRead: 300, cacheWrite: 200, cost: 0.20 },
    ];
    const deduped = deduplicateRecords(records);
    assert.equal(deduped.length, 1);
    assert.ok(Math.abs(deduped[0].cost - 0.30) < 0.0001);
    assert.equal(deduped[0].inputTokens, 1000);
    assert.equal(deduped[0].outputTokens, 500);
  });

  it('keeps records with different workspaces separate', () => {
    const records = [
      { date: '2026-02-15T00:00:00.000Z', model: 'claude-sonnet-4-20250514', workspace: 'w1', cost: 0.10 },
      { date: '2026-02-15T00:00:00.000Z', model: 'claude-sonnet-4-20250514', workspace: 'w2', cost: 0.10 },
    ];
    const deduped = deduplicateRecords(records);
    assert.equal(deduped.length, 2);
  });
});
