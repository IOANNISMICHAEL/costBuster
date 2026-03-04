const fs = require('fs');
const path = require('path');

const PRICING = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  'claude-3-opus-20240229': { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.50 },
};

function estimateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens) {
  const pricing = findPricing(model);
  if (!pricing) return null;
  const m = 1_000_000;
  return (
    (inputTokens / m) * pricing.input +
    (outputTokens / m) * pricing.output +
    (cacheWriteTokens / m) * pricing.cacheWrite +
    (cacheReadTokens / m) * pricing.cacheRead
  );
}

function findPricing(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  for (const key of Object.keys(PRICING)) {
    if (model.includes(key) || key.includes(model)) return PRICING[key];
  }
  if (model.includes('opus')) return PRICING['claude-3-opus-20240229'];
  if (model.includes('sonnet')) return PRICING['claude-sonnet-4-20250514'];
  if (model.includes('haiku')) return PRICING['claude-haiku-4-5-20251001'];
  return null;
}

/** Returns ISO date string (for .slice(0,10)) or null. Handles ISO strings and Unix ms. */
function parseTimestamp(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    const d = new Date(val < 1e12 ? val * 1000 : val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof val !== 'string') return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function getRecordDate(obj, fileMtimeIso) {
  return (
    parseTimestamp(obj.timestamp) ||
    parseTimestamp(obj.created_at) ||
    parseTimestamp(obj.message?.created) ||
    fileMtimeIso
  );
}

function parseAnthropicDir(dataDir) {
  const records = [];
  const warnings = [];

  if (!fs.existsSync(dataDir)) {
    warnings.push(`Anthropic data dir not found: ${dataDir}`);
    return { records, warnings };
  }

  const projectsDir = path.join(dataDir, 'projects');
  const jsonlFiles = [];

  if (fs.existsSync(projectsDir)) {
    collectJsonlFiles(projectsDir, jsonlFiles);
  }

  const historyFile = path.join(dataDir, 'history.jsonl');
  if (fs.existsSync(historyFile)) {
    jsonlFiles.push(historyFile);
  }

  for (const file of jsonlFiles) {
    try {
      parseAnthropicJsonl(file, records, warnings);
    } catch (err) {
      warnings.push(`Failed to read ${file}: ${err.message}`);
    }
  }

  return { records, warnings };
}

function collectJsonlFiles(dir, result) {
  const resolved = fs.realpathSync(dir);
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    const full = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(full, result);
    } else if (entry.name.endsWith('.jsonl')) {
      result.push(full);
    }
  }
}

function parseAnthropicJsonl(filePath, records, warnings) {
  let fileMtimeIso = null;
  try {
    const stat = fs.statSync(filePath);
    fileMtimeIso = stat.mtime.toISOString();
  } catch {
    // ignore; fileMtimeIso stays null, getRecordDate will still use obj fields
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const userMessages = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      warnings.push(`${filePath}:${i + 1}: invalid JSON, skipped`);
      continue;
    }

    if (obj.type === 'user' && obj.message) {
      userMessages.set(obj.uuid, extractSnippet(obj.message));
      continue;
    }

    if (obj.type !== 'assistant') continue;

    const msg = obj.message;
    if (!msg || !msg.usage) continue;

    const model = msg.model;
    if (model === '<synthetic>') continue;

    const usage = msg.usage;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    if (inputTokens === 0 && outputTokens === 0) continue;

    const cacheWriteTokens = (usage.cache_creation_input_tokens || 0) +
      (usage.cache_creation?.ephemeral_5m_input_tokens || 0) +
      (usage.cache_creation?.ephemeral_1h_input_tokens || 0);
    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    let promptSnippet = null;
    if (obj.parentUuid && userMessages.has(obj.parentUuid)) {
      promptSnippet = userMessages.get(obj.parentUuid);
    }

    const cost = estimateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);

    records.push({
      provider: 'anthropic',
      date: getRecordDate(obj, fileMtimeIso),
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      cost,
      sessionId: obj.sessionId || null,
      project: extractProject(obj.cwd, filePath),
      promptSnippet,
      sourceFile: filePath,
    });
  }
}

function extractSnippet(message) {
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    const parts = [];
    for (const block of message.content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
    text = parts.join(' ');
  }
  text = text.replace(/<ide_selection>[\s\S]*?<\/ide_selection>\s*/g, '').trim();
  if (text.length > 120) text = text.slice(0, 120) + '…';
  return text || null;
}

function extractProject(cwd, filePath) {
  if (cwd) return path.basename(cwd);
  const parts = filePath.split(path.sep);
  const projIdx = parts.indexOf('projects');
  if (projIdx >= 0 && projIdx + 1 < parts.length) {
    const encoded = parts[projIdx + 1];
    const decoded = encoded.replace(/^-/, '/').replace(/-/g, '/');
    return path.basename(decoded) || encoded;
  }
  return null;
}

module.exports = { parseAnthropicDir, estimateCost, findPricing, PRICING };
