const { parseAnthropicDir, findPricing: findAnthropicPricing } = require('./anthropic');
const { parseOpenAI } = require('./openai');
const { fetchAnthropicApi } = require('./anthropic-api');

async function getAllRecords(config) {
  const allRecords = [];
  const allWarnings = [];

  const anthropic = parseAnthropicDir(config.anthropicDataDir);
  allRecords.push(...anthropic.records);
  allWarnings.push(...anthropic.warnings);

  let keyTotals = [];
  if (config.anthropicAdminKeys && config.anthropicAdminKeys.length > 0) {
    const apiResult = await fetchAnthropicApi(config.anthropicAdminKeys, config.anthropicApiSyncDays || 30);
    allRecords.push(...apiResult.records);
    allWarnings.push(...apiResult.warnings);
    keyTotals = apiResult.keyTotals || [];
  }

  const openai = parseOpenAI(config);
  allRecords.push(...openai.records);
  allWarnings.push(...openai.warnings);

  allRecords.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  return { records: allRecords, warnings: allWarnings, keyTotals };
}

function computeAggregations(records, keyTotals) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
  const byProvider = {};
  const byDay = {};
  const byModel = {};
  const byProject = {};
  const bySession = {};
  for (const r of records) {
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheRead += r.cacheRead;
    totals.cacheWrite += r.cacheWrite;
    totals.cost += r.cost || 0;
    totals.count++;

    aggregate(byProvider, r.provider, r);

    const day = r.date ? r.date.slice(0, 10) : 'unknown';
    aggregate(byDay, day, r);

    aggregate(byModel, r.model, r);

    if (r.project) {
      aggregate(byProject, r.project, r);
    }

    if (r.sessionId) {
      aggregate(bySession, `${r.provider}:${r.sessionId}`, r);
    }

  }

  totals.cost = round(totals.cost);

  const byApiKey = Array.isArray(keyTotals) ? [...keyTotals].sort((a, b) => b.cost - a.cost) : [];

  return {
    totals,
    byProvider: formatAgg(byProvider),
    byDay: formatAgg(byDay),
    byModel: formatAgg(byModel),
    byProject: formatAgg(byProject),
    byApiKey,
    bySession: Object.entries(bySession)
      .map(([key, v]) => ({
        key,
        provider: key.split(':')[0],
        sessionId: key.split(':').slice(1).join(':'),
        ...formatEntry(v),
      }))
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)),
  };
}

function aggregate(map, key, record) {
  if (!map[key]) map[key] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, count: 0 };
  map[key].inputTokens += record.inputTokens || 0;
  map[key].outputTokens += record.outputTokens || 0;
  map[key].cacheRead += record.cacheRead || 0;
  map[key].cacheWrite += record.cacheWrite || 0;
  map[key].cost += record.cost || 0;
  map[key].count++;
}

function formatAgg(map) {
  return Object.entries(map)
    .map(([key, v]) => ({ key, ...formatEntry(v) }))
    .sort((a, b) => b.cost - a.cost);
}

function formatEntry(v) {
  return {
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cacheRead: v.cacheRead,
    cacheWrite: v.cacheWrite,
    cost: round(v.cost),
    count: v.count,
  };
}

function round(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function generateInsights(records, aggregations) {
  const insights = [];
  const { totals, byProvider, byModel } = aggregations;

  if (totals.count === 0) {
    insights.push('No usage records found. Check your data directory configuration.');
    return insights;
  }

  if (byProvider.length > 1) {
    const parts = byProvider.map(p => {
      const pct = totals.cost > 0 ? ((p.cost / totals.cost) * 100).toFixed(1) : 0;
      return `${p.key}: ${pct}% of cost`;
    });
    insights.push(`Provider split: ${parts.join(', ')}.`);
  }

  if (byModel.length > 0) {
    const mostUsed = [...byModel].sort((a, b) => b.count - a.count)[0];
    insights.push(`Most used model: ${mostUsed.key} (${mostUsed.count} requests, $${mostUsed.cost.toFixed(4)} total).`);
    if (byModel[0].key !== mostUsed.key) {
      insights.push(`Most expensive model: ${byModel[0].key} ($${byModel[0].cost.toFixed(4)} total, ${byModel[0].count} requests).`);
    }
  }

  const totalTokens = totals.inputTokens + totals.outputTokens;
  if (totalTokens > 0) {
    const ratio = (totals.inputTokens / totalTokens * 100).toFixed(1);
    insights.push(`Input/output ratio: ${ratio}% input, ${(100 - parseFloat(ratio)).toFixed(1)}% output tokens.`);
  }

  if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
    const cacheTotal = totals.cacheRead + totals.cacheWrite;
    const cachePct = ((cacheTotal / (totalTokens + cacheTotal)) * 100).toFixed(1);
    insights.push(`Cache usage: ${cachePct}% of all tokens involved caching (${totals.cacheRead.toLocaleString()} read, ${totals.cacheWrite.toLocaleString()} write).`);

    if (totals.cacheRead > 0) {
      const defaultInputPrice = 3.0;
      const savedEstimate = estimateCacheSavings(records, defaultInputPrice);
      if (savedEstimate > 0.001) {
        insights.push(`Estimated cache savings: ~$${savedEstimate.toFixed(4)} (cache reads priced at ~10% of full input cost).`);
      }
    }
  }

  if (aggregations.bySession.length > 0) {
    const top = aggregations.bySession[0];
    const topTokens = top.inputTokens + top.outputTokens;
    insights.push(`Largest session: ${top.sessionId.slice(0, 12)}… (${topTokens.toLocaleString()} tokens, $${top.cost.toFixed(4)}).`);
  }

  return insights;
}

function estimateCacheSavings(records, defaultInputPrice) {
  let savings = 0;
  const m = 1_000_000;
  for (const r of records) {
    if (r.cacheRead <= 0) continue;
    let inputPrice = defaultInputPrice;
    if (r.model) {
      const pricing = findAnthropicPricing(r.model);
      if (pricing) inputPrice = pricing.input;
    }
    savings += (r.cacheRead / m) * inputPrice * 0.9;
  }
  return savings;
}

module.exports = { getAllRecords, computeAggregations, generateInsights };
