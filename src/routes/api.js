const { Router } = require('express');
const express = require('express');
const { getAllRecords, computeAggregations, generateInsights } = require('../parsers/merge');
const { saveSettings, validatePath, isUnderHome, resolvePath, validateAdminKey, maskAdminKey } = require('../settings');

function simpleRateLimit(windowMs, maxRequests) {
  const hits = new Map();
  let lastSweep = Date.now();
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
      lastSweep = now;
    }
    const key = req.ip || 'unknown';
    const entry = hits.get(key);
    if (entry && now - entry.start < windowMs) {
      entry.count++;
      if (entry.count > maxRequests) {
        return res.status(429).json({ error: 'Too many requests, try again later' });
      }
    } else {
      hits.set(key, { start: now, count: 1 });
    }
    next();
  };
}

const CACHE_TTL_MS = 5 * 60 * 1000;

function createApiRouter(config) {
  const router = Router();
  let dataCache = null;

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
  });

  function buildResponse(records, warnings, keyTotals) {
    const aggregations = computeAggregations(records, keyTotals);
    const insights = generateInsights(records, aggregations);
    const topPrompts = records
      .filter(r => r.promptSnippet)
      .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      .slice(0, 20)
      .map(r => ({
        provider: r.provider,
        model: r.model,
        date: r.date,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cost: r.cost,
        snippet: r.promptSnippet,
      }));

    return {
      records: records.map(stripSourceFile),
      aggregations,
      insights,
      topPrompts,
      warnings,
      meta: {
        recordCount: records.length,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  async function fetchAndCache() {
    const { records, warnings, keyTotals } = await getAllRecords(config);
    const payload = buildResponse(records, warnings, keyTotals);
    dataCache = { payload, timestamp: Date.now() };
    return payload;
  }

  router.get('/data', async (req, res) => {
    try {
      const force = req.query.force === '1';
      if (!force && dataCache && (Date.now() - dataCache.timestamp) < CACHE_TTL_MS) {
        return res.json(dataCache.payload);
      }
      dataCache = null;
      const payload = await fetchAndCache();
      res.json(payload);
    } catch (err) {
      console.error('Error generating data:', err);
      res.status(500).json({ error: 'Failed to generate data' });
    }
  });

  const refreshLimiter = simpleRateLimit(60_000, 5);

  router.get('/refresh', refreshLimiter, async (req, res) => {
    try {
      dataCache = null;
      const payload = await fetchAndCache();
      res.json({ ok: true, recordCount: payload.meta.recordCount, warnings: payload.warnings });
    } catch (err) {
      console.error('Error refreshing:', err);
      res.status(500).json({ error: 'Failed to refresh' });
    }
  });

  router.get('/settings', (req, res) => {
    res.json({
      anthropicDataDir: config.anthropicDataDir,
      anthropicAdminKeys: (config.anthropicAdminKeys || []).map(maskAdminKey),
      anthropicAdminKeyCount: (config.anthropicAdminKeys || []).length,
      anthropicApiSyncDays: config.anthropicApiSyncDays || 30,
      openaiUsageFile: config.openaiUsageFile,
      openaiLogsDir: config.openaiLogsDir,
    });
  });

  const settingsJson = express.json({ limit: '10kb' });
  const settingsLimiter = simpleRateLimit(60_000, 10);

  router.post('/settings', settingsLimiter, settingsJson, (req, res) => {
    try {
      const { anthropicDataDir, anthropicAdminKeys, anthropicApiSyncDays, openaiUsageFile, openaiLogsDir } = req.body || {};

      const resolved = {
        anthropicDataDir: resolvePath(anthropicDataDir || '~/.claude'),
        openaiUsageFile: openaiUsageFile ? resolvePath(openaiUsageFile) : '',
        openaiLogsDir: openaiLogsDir ? resolvePath(openaiLogsDir) : '',
      };

      for (const [key, val] of Object.entries(resolved)) {
        if (val && !isUnderHome(val)) {
          return res.status(400).json({ error: `${key} must be within home directory` });
        }
      }

      const existingKeys = config.anthropicAdminKeys || [];
      let finalKeys;
      if (anthropicAdminKeys === undefined) {
        finalKeys = existingKeys;
      } else {
        const incomingKeys = Array.isArray(anthropicAdminKeys) ? anthropicAdminKeys : [];
        finalKeys = incomingKeys.map(k => {
          if (typeof k === 'string' && k.startsWith('__keep__:')) {
            const idx = parseInt(k.split(':')[1], 10);
            if (!Number.isFinite(idx) || idx < 0 || idx >= existingKeys.length) return null;
            return existingKeys[idx];
          }
          return k;
        }).filter(Boolean);
        const invalidKeys = finalKeys.filter(k => !validateAdminKey(k));
        if (invalidKeys.length > 0) {
          return res.status(400).json({ error: 'Invalid admin key format. Keys must start with sk-ant-admin and be at least 20 characters.' });
        }
      }

      const saved = saveSettings({
        ...resolved,
        anthropicAdminKeys: finalKeys,
        anthropicApiSyncDays: typeof anthropicApiSyncDays === 'number' ? anthropicApiSyncDays : 30,
      });

      config.anthropicDataDir = saved.anthropicDataDir;
      config.anthropicAdminKeys = saved.anthropicAdminKeys;
      config.anthropicApiSyncDays = saved.anthropicApiSyncDays;
      config.openaiUsageFile = saved.openaiUsageFile;
      config.openaiLogsDir = saved.openaiLogsDir;
      dataCache = null;

      res.json({
        ok: true,
        settings: {
          ...saved,
          anthropicAdminKeys: saved.anthropicAdminKeys.map(maskAdminKey),
        },
      });
    } catch (err) {
      console.error('Error saving settings:', err);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  router.post('/settings/validate', settingsLimiter, settingsJson, (req, res) => {
    const { path: p } = req.body || {};
    if (!p) return res.json({ valid: false, reason: 'Path is empty' });
    const result = validatePath(p);
    res.json(result);
  });

  return router;
}

function stripSourceFile(record) {
  const { sourceFile, ...rest } = record;
  return rest;
}

module.exports = { createApiRouter };
