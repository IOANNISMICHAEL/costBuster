const fs = require('fs');
const path = require('path');

const PRICING = {
  'gpt-4o': { input: 2.50, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gpt-4': { input: 30.0, output: 60.0 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'o1': { input: 15.0, output: 60.0 },
  'o1-mini': { input: 3.0, output: 12.0 },
  'o3-mini': { input: 1.10, output: 4.40 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const pricing = findPricing(model);
  if (!pricing) return null;
  const m = 1_000_000;
  return (inputTokens / m) * pricing.input + (outputTokens / m) * pricing.output;
}

function findPricing(model) {
  if (!model) return null;
  if (PRICING[model]) return PRICING[model];
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return null;
}

function parseOpenAI(config) {
  const records = [];
  const warnings = [];

  if (config.openaiUsageFile) {
    parseFile(config.openaiUsageFile, records, warnings);
  }

  if (config.openaiLogsDir) {
    parseLogsDir(config.openaiLogsDir, records, warnings);
  }

  return { records, warnings };
}

function parseFile(filePath, records, warnings) {
  if (!fs.existsSync(filePath)) {
    warnings.push(`OpenAI usage file not found: ${filePath}`);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (ext === '.csv') {
      parseCsv(content, filePath, records, warnings);
    } else if (ext === '.jsonl') {
      parseJsonl(content, filePath, records, warnings);
    } else if (ext === '.json') {
      parseJson(content, filePath, records, warnings);
    } else {
      const firstChar = content.trim()[0];
      if (firstChar === '{' || firstChar === '[') {
        if (content.trim().startsWith('[')) {
          parseJson(content, filePath, records, warnings);
        } else {
          parseJsonl(content, filePath, records, warnings);
        }
      } else {
        parseCsv(content, filePath, records, warnings);
      }
    }
  } catch (err) {
    warnings.push(`Failed to read ${filePath}: ${err.message}`);
  }
}

function parseLogsDir(dirPath, records, warnings) {
  if (!fs.existsSync(dirPath)) {
    warnings.push(`OpenAI logs dir not found: ${dirPath}`);
    return;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (['.json', '.jsonl', '.csv'].includes(ext)) {
      parseFile(path.join(dirPath, entry.name), records, warnings);
    }
  }
}

function parseJsonl(content, filePath, records, warnings) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const record = mapJsonRecord(obj, filePath);
      if (record) records.push(record);
    } catch {
      warnings.push(`${filePath}:${i + 1}: invalid JSON, skipped`);
    }
  }
}

function parseJson(content, filePath, records, warnings) {
  try {
    const data = JSON.parse(content);
    const arr = Array.isArray(data) ? data : [data];
    for (const obj of arr) {
      const record = mapJsonRecord(obj, filePath);
      if (record) records.push(record);
    }
  } catch (err) {
    warnings.push(`${filePath}: invalid JSON: ${err.message}`);
  }
}

function mapJsonRecord(obj, filePath) {
  const usage = obj.usage || obj;
  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
  if (inputTokens === 0 && outputTokens === 0) return null;

  const model = obj.model || usage.model || 'unknown';
  let date = null;
  if (obj.created) {
    date = new Date(obj.created * 1000).toISOString();
  } else if (obj.timestamp) {
    date = obj.timestamp;
  } else if (obj.date) {
    date = obj.date;
  }

  const cost = usage.total_cost ?? usage.cost_usd ?? estimateCost(model, inputTokens, outputTokens);

  return {
    provider: 'openai',
    date,
    model,
    inputTokens,
    outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    cost,
    sessionId: obj.id || obj.session_id || null,
    project: null,
    promptSnippet: null,
    sourceFile: filePath,
  };
}

function parseCsv(content, filePath, records, warnings) {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    warnings.push(`${filePath}: CSV has no data rows`);
    return;
  }

  const header = splitCsvLine(lines[0]).map(h => h.toLowerCase());
  const colIdx = {
    date: findCol(header, ['date', 'timestamp', 'time']),
    model: findCol(header, ['model', 'model_id']),
    input: findCol(header, ['prompt_tokens', 'input_tokens']),
    output: findCol(header, ['completion_tokens', 'output_tokens']),
    cost: findCol(header, ['cost_usd', 'cost', 'total_cost']),
  };

  if (colIdx.input === -1 && colIdx.output === -1 && colIdx.cost === -1) {
    warnings.push(`${filePath}: CSV missing token or cost columns`);
    return;
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const inputTokens = colIdx.input >= 0 ? parseInt(cols[colIdx.input], 10) || 0 : 0;
    const outputTokens = colIdx.output >= 0 ? parseInt(cols[colIdx.output], 10) || 0 : 0;
    if (inputTokens === 0 && outputTokens === 0 && colIdx.cost === -1) continue;

    const model = colIdx.model >= 0 ? cols[colIdx.model] : 'unknown';
    const date = colIdx.date >= 0 ? cols[colIdx.date] : null;
    const rawCost = colIdx.cost >= 0 ? parseFloat(cols[colIdx.cost]) : NaN;
    const csvCost = isNaN(rawCost) ? null : rawCost;
    const cost = csvCost ?? estimateCost(model, inputTokens, outputTokens);

    records.push({
      provider: 'openai',
      date,
      model,
      inputTokens,
      outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost,
      sessionId: null,
      project: null,
      promptSnippet: null,
      sourceFile: filePath,
    });
  }
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

function findCol(header, candidates) {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx >= 0) return idx;
  }
  return -1;
}

module.exports = { parseOpenAI, PRICING };
