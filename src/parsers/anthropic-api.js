const { estimateCost } = require('./anthropic');

const API_BASE = 'https://api.anthropic.com/v1/organizations';
const REQUEST_TIMEOUT_MS = 30_000;
const USAGE_TIMEOUT_MS = 180_000;
const RETRY_500_DELAY_MS = 2_000;
const API_VERSION = '2023-06-01';
const MAX_PAGES = 100;

async function fetchAnthropicApi(adminKeys, syncDays) {
  const records = [];
  const warnings = [];
  const keyTotals = [];

  if (!Array.isArray(adminKeys) || adminKeys.length === 0) {
    return { records, warnings, keyTotals };
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - Math.max(1, syncDays));

  const startingAt = startDate.toISOString().replace(/\.\d+Z$/, 'Z');
  const endingAt = endDate.toISOString().replace(/\.\d+Z$/, 'Z');

  for (const adminKey of adminKeys) {
    try {
      const masked = adminKey.slice(0, 12) + '…' + adminKey.slice(-4);

      const keyNameMap = await fetchApiKeyNames(adminKey).catch(() => new Map());
      const apiKeyIds = [...keyNameMap.keys()];

      const parallelTasks = [
        fetchCostReport(adminKey, startingAt, endingAt),
        fetchUsageReport(adminKey, startingAt, endingAt).catch(err => {
          warnings.push(`Anthropic API: key ${masked} — usage data unavailable (${err.message}). Token counts may be incomplete.`);
          return [];
        }),
      ];

      if (apiKeyIds.length > 0) {
        parallelTasks.push(
          fetchKeyTotals(adminKey, startingAt, endingAt, apiKeyIds, keyNameMap, warnings)
        );
      }

      const [costBuckets, usageBuckets, totals] = await Promise.all(parallelTasks);

      const costRecords = buildCostRecords(costBuckets);
      enrichWithUsage(costRecords, usageBuckets, records);
      records.push(...costRecords);

      if (totals && totals.length > 0) {
        keyTotals.push(...totals);
      }
    } catch (err) {
      const masked = adminKey.slice(0, 12) + '…' + adminKey.slice(-4);
      if (err.statusCode === 401 || err.statusCode === 403) {
        warnings.push(`Anthropic API: key ${masked} — authentication failed (${err.statusCode}). Check that it's a valid Admin API key.`);
      } else if (err.statusCode === 404) {
        warnings.push(`Anthropic API: key ${masked} — endpoint not found. Admin API may not be available for individual accounts.`);
      } else {
        warnings.push(`Anthropic API: key ${masked} — ${err.message}`);
      }
    }
  }

  return { records: deduplicateRecords(records), warnings, keyTotals };
}

async function fetchApiKeyNames(adminKey) {
  const nameMap = new Map();
  let afterId = null;

  for (let page = 0; page < 10; page++) {
    const afterParam = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
    const url = `${API_BASE}/api_keys?limit=100${afterParam}`;
    const data = await apiGet(url, adminKey);
    for (const k of (data.data || [])) {
      if (k.id && k.name) nameMap.set(k.id, k.name);
    }
    if (!data.has_more) break;
    afterId = data.last_id;
  }

  return nameMap;
}

async function fetchCostReport(adminKey, startingAt, endingAt) {
  const buckets = [];
  let page = null;
  let pageCount = 0;

  for (;;) {
    if (++pageCount > MAX_PAGES) break;
    const pageParam = page ? `&page=${encodeURIComponent(page)}` : '';
    const url = `${API_BASE}/cost_report?starting_at=${startingAt}&ending_at=${endingAt}&bucket_width=1d&group_by[]=workspace_id&group_by[]=description&limit=31${pageParam}`;

    const data = await apiGet(url, adminKey);
    if (Array.isArray(data.data)) {
      for (const bucket of data.data) {
        for (const r of (bucket.results || [])) {
          buckets.push({
            ...r,
            bucket_start_time: bucket.starting_at,
            cost_cents: r.amount != null ? r.amount : null,
          });
        }
      }
    }
    if (!data.has_more) break;
    page = data.next_page;
  }

  return buckets;
}

async function fetchUsageReport(adminKey, startingAt, endingAt) {
  const buckets = [];
  let page = null;
  let pageCount = 0;

  const groupParams = ['model', 'workspace_id'].map(g => `group_by[]=${g}`).join('&');

  for (;;) {
    if (++pageCount > MAX_PAGES) break;
    const pageParam = page ? `&page=${encodeURIComponent(page)}` : '';
    const url = `${API_BASE}/usage_report/messages?starting_at=${startingAt}&ending_at=${endingAt}&bucket_width=1d&${groupParams}&limit=31${pageParam}`;

    const data = await apiGet(url, adminKey, false, USAGE_TIMEOUT_MS);
    if (Array.isArray(data.data)) {
      for (const bucket of data.data) {
        for (const r of (bucket.results || [])) {
          buckets.push({ ...r, bucket_start_time: bucket.starting_at });
        }
      }
    }
    if (!data.has_more) break;
    page = data.next_page;
  }

  return buckets;
}

async function fetchKeyTotals(adminKey, startingAt, endingAt, apiKeyIds, keyNameMap, warnings) {
  const totals = [];

  const fetches = apiKeyIds.map(async (keyId) => {
    const url = `${API_BASE}/usage_report/messages?starting_at=${startingAt}&ending_at=${endingAt}&bucket_width=1d&api_key_ids[]=${encodeURIComponent(keyId)}&limit=31`;
    try {
      const data = await apiGet(url, adminKey, false, USAGE_TIMEOUT_MS);
      let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
      for (const bucket of (data.data || [])) {
        for (const r of (bucket.results || [])) {
          inputTokens += r.uncached_input_tokens || 0;
          outputTokens += r.output_tokens || 0;
          cacheRead += r.cache_read_input_tokens || 0;
          cacheWrite += (r.cache_creation?.ephemeral_5m_input_tokens || 0)
            + (r.cache_creation?.ephemeral_1h_input_tokens || 0);
        }
      }
      if (inputTokens > 0 || outputTokens > 0 || cacheRead > 0 || cacheWrite > 0) {
        const name = keyNameMap.get(keyId) || keyId;
        const cost = estimateCost('claude-sonnet-4-20250514', inputTokens, outputTokens, cacheWrite, cacheRead);
        totals.push({ key: name, inputTokens, outputTokens, cacheRead, cacheWrite, cost, count: 1 });
      }
    } catch (err) {
      const name = keyNameMap.get(keyId) || keyId.slice(0, 10) + '…';
      warnings.push(`Anthropic API: per-key usage for "${name}" unavailable — ${err.message}`);
    }
  });

  await Promise.all(fetches);
  return totals;
}

function buildCostRecords(costBuckets) {
  const records = [];
  for (const b of costBuckets) {
    const date = b.bucket_start_time ? b.bucket_start_time.slice(0, 10) : null;
    const model = b.model || extractModelFromDescription(b.description);
    const workspace = b.workspace_id || null;
    const cost = parseCostValue(b.cost_cents);

    if (!date || !model || cost == null) continue;

    records.push({
      provider: 'anthropic-api',
      date: `${date}T00:00:00.000Z`,
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
      workspace,
      contextWindow: null,
      inferenceGeo: null,
      speed: null,
      webSearchCount: 0,
      sessionId: null,
      project: null,
      promptSnippet: null,
      sourceFile: null,
    });
  }
  return records;
}

function enrichWithUsage(costRecords, usageBuckets, allRecords) {
  if (!usageBuckets || usageBuckets.length === 0) return;

  const SEP = '\x00';
  const usageMap = new Map();
  for (const b of usageBuckets) {
    const date = b.bucket_start_time ? b.bucket_start_time.slice(0, 10) : null;
    const model = b.model || 'unknown';
    const workspace = b.workspace_id || null;
    if (!date) continue;

    const key = `${date}${SEP}${model}${SEP}${workspace}`;
    const existing = usageMap.get(key) || { date, model, workspace, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, webSearchCount: 0 };
    existing.inputTokens += b.uncached_input_tokens || 0;
    existing.outputTokens += b.output_tokens || 0;
    existing.cacheRead += b.cache_read_input_tokens || 0;
    existing.cacheWrite += (b.cache_creation?.ephemeral_5m_input_tokens || 0)
      + (b.cache_creation?.ephemeral_1h_input_tokens || 0);
    existing.webSearchCount += b.server_tool_use?.web_search_requests || 0;
    usageMap.set(key, existing);
  }

  const matchedKeys = new Set();
  for (const r of costRecords) {
    const date = r.date ? r.date.slice(0, 10) : null;
    const key = `${date}${SEP}${r.model}${SEP}${r.workspace}`;
    const usage = usageMap.get(key);
    if (usage) {
      r.inputTokens = usage.inputTokens;
      r.outputTokens = usage.outputTokens;
      r.cacheRead = usage.cacheRead;
      r.cacheWrite = usage.cacheWrite;
      r.webSearchCount = usage.webSearchCount;
      matchedKeys.add(key);
    }
  }

  for (const [key, usage] of usageMap) {
    if (matchedKeys.has(key)) continue;
    if (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) continue;
    allRecords.push({
      provider: 'anthropic-api',
      date: `${usage.date}T00:00:00.000Z`,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: estimateCost(usage.model, usage.inputTokens, usage.outputTokens, usage.cacheWrite, usage.cacheRead),
      workspace: usage.workspace,
      contextWindow: null,
      inferenceGeo: null,
      speed: null,
      webSearchCount: usage.webSearchCount,
      sessionId: null,
      project: null,
      promptSnippet: null,
      sourceFile: null,
    });
  }
}

async function apiGet(url, adminKey, _retried = false, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': API_VERSION,
        'User-Agent': 'CostBuster/1.0.0',
      },
      signal: controller.signal,
    });

    if (!resp.ok) {
      if (resp.status === 500 && !_retried) {
        clearTimeout(timer);
        await new Promise(r => setTimeout(r, RETRY_500_DELAY_MS));
        return apiGet(url, adminKey, true, timeoutMs);
      }
      const err = new Error(`Anthropic API returned ${resp.status}`);
      err.statusCode = resp.status;
      throw err;
    }

    return await resp.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error('Anthropic API request timed out');
      timeoutErr.statusCode = 0;
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function extractModelFromDescription(desc) {
  if (!desc) return null;
  const match = desc.match(/claude[a-z0-9._-]+/i);
  return match ? match[0] : null;
}

function parseCostValue(val) {
  if (val == null) return null;
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (!Number.isFinite(num)) return null;
  return num / 100;
}

function deduplicateRecords(records) {
  const seen = new Map();
  for (const r of records) {
    const key = `${r.date}|${r.model}|${r.workspace}`;
    const existing = seen.get(key);
    if (existing) {
      existing.cost += r.cost || 0;
      existing.inputTokens = Math.max(existing.inputTokens, r.inputTokens || 0);
      existing.outputTokens = Math.max(existing.outputTokens, r.outputTokens || 0);
      existing.cacheRead = Math.max(existing.cacheRead, r.cacheRead || 0);
      existing.cacheWrite = Math.max(existing.cacheWrite, r.cacheWrite || 0);
    } else {
      seen.set(key, { ...r });
    }
  }
  return [...seen.values()];
}

module.exports = { fetchAnthropicApi, fetchCostReport, fetchUsageReport, fetchApiKeyNames, fetchKeyTotals, deduplicateRecords, enrichWithUsage };
