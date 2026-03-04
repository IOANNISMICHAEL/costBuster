const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseAnthropicDir } = require('../src/parsers/anthropic');
const { parseOpenAI } = require('../src/parsers/openai');
const { getAllRecords, computeAggregations, generateInsights } = require('../src/parsers/merge');
const { loadConfig, parseArgs, resolveHome } = require('../src/config');
const { SETTINGS_FILE } = require('../src/settings');

const FIXTURES = path.join(__dirname, 'fixtures');
const HAS_SAVED_CONFIG = fs.existsSync(SETTINGS_FILE);

describe('Anthropic parser', () => {
  it('parses valid JSONL and extracts assistant records only', () => {
    const { records, warnings } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    assert.equal(records.length, 3, 'should have 3 records (2 from session1 + 1 from no-timestamp; skips synthetic + queue-op + user lines)');
    assert.ok(records.every(r => r.provider === 'anthropic'));
  });

  it('skips <synthetic> model entries', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    assert.ok(records.every(r => r.model !== '<synthetic>'));
  });

  it('extracts correct token counts for first record', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    const r = records.find(r => r.model === 'claude-sonnet-4-20250514' && r.inputTokens === 500);
    assert.ok(r);
    assert.equal(r.inputTokens, 500);
    assert.equal(r.outputTokens, 200);
    assert.equal(r.cacheRead, 50);
    assert.equal(r.cacheWrite, 115); // 100 + 10 + 5
  });

  it('extracts prompt snippet from user message, stripping ide_selection', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    const r = records.find(r => r.model === 'claude-haiku-4-5-20251001');
    assert.ok(r);
    assert.equal(r.promptSnippet, 'Fix the bug in line 5');
  });

  it('extracts project name from cwd field', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    assert.ok(records.every(r => r.project !== undefined));
    const r = records[0];
    assert.equal(r.project, 'test');
  });

  it('estimates cost using pricing table', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    assert.ok(records.every(r => r.cost !== null && r.cost > 0));
  });

  it('handles missing directory gracefully', () => {
    const { records, warnings } = parseAnthropicDir('/nonexistent/path');
    assert.equal(records.length, 0);
    assert.ok(warnings.length > 0);
  });

  it('uses timestamp from JSONL when present', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    const withTimestamp = records.find(r => r.date && r.date.startsWith('2025-11-07'));
    assert.ok(withTimestamp, 'record with timestamp should have date 2025-11-07');
    assert.equal(withTimestamp.date.slice(0, 10), '2025-11-07');
  });

  it('uses file mtime when timestamp is missing', () => {
    const { records } = parseAnthropicDir(path.join(FIXTURES, 'anthropic'));
    const noTimestamp = records.find(r => r.sourceFile && r.sourceFile.includes('no-timestamp'));
    assert.ok(noTimestamp, 'record from no-timestamp.jsonl should exist');
    assert.ok(noTimestamp.date, 'record without timestamp should get date from file mtime');
    assert.match(noTimestamp.date, /^\d{4}-\d{2}-\d{2}T/, 'date should be ISO format');
  });
});

describe('OpenAI parser — JSONL', () => {
  it('parses JSONL API response logs', () => {
    const { records, warnings } = parseOpenAI({
      openaiUsageFile: '',
      openaiLogsDir: path.join(FIXTURES, 'openai', 'logs'),
    });
    assert.equal(records.length, 2);
    assert.ok(records.every(r => r.provider === 'openai'));
  });

  it('maps prompt_tokens and completion_tokens correctly', () => {
    const { records } = parseOpenAI({
      openaiUsageFile: '',
      openaiLogsDir: path.join(FIXTURES, 'openai', 'logs'),
    });
    const r = records.find(r => r.model === 'gpt-4o');
    assert.ok(r);
    assert.equal(r.inputTokens, 1200);
    assert.equal(r.outputTokens, 350);
  });

  it('sets project to null for OpenAI records', () => {
    const { records } = parseOpenAI({
      openaiUsageFile: '',
      openaiLogsDir: path.join(FIXTURES, 'openai', 'logs'),
    });
    assert.ok(records.every(r => r.project === null));
  });

  it('converts unix created timestamp to ISO date', () => {
    const { records } = parseOpenAI({
      openaiUsageFile: '',
      openaiLogsDir: path.join(FIXTURES, 'openai', 'logs'),
    });
    assert.ok(records[0].date);
    assert.ok(records[0].date.includes('2023-11'));
  });
});

describe('OpenAI parser — CSV', () => {
  it('parses CSV export with correct columns', () => {
    const { records, warnings } = parseOpenAI({
      openaiUsageFile: path.join(FIXTURES, 'openai', 'usage.csv'),
      openaiLogsDir: '',
    });
    assert.equal(records.length, 3);
    assert.ok(records.every(r => r.provider === 'openai'));
  });

  it('uses cost_usd from CSV when present', () => {
    const { records } = parseOpenAI({
      openaiUsageFile: path.join(FIXTURES, 'openai', 'usage.csv'),
      openaiLogsDir: '',
    });
    assert.equal(records[0].cost, 1.23);
    assert.equal(records[1].cost, 0.45);
  });
});

describe('Merge and aggregations', () => {
  const config = {
    anthropicDataDir: path.join(FIXTURES, 'anthropic'),
    anthropicAdminKeys: [],
    anthropicApiSyncDays: 30,
    openaiUsageFile: path.join(FIXTURES, 'openai', 'usage.csv'),
    openaiLogsDir: path.join(FIXTURES, 'openai', 'logs'),
  };

  it('merges records from both providers sorted by date', async () => {
    const { records } = await getAllRecords(config);
    assert.ok(records.length >= 5);
    const providers = new Set(records.map(r => r.provider));
    assert.ok(providers.has('anthropic'));
    assert.ok(providers.has('openai'));
  });

  it('computes aggregations including byProject', async () => {
    const { records } = await getAllRecords(config);
    const agg = computeAggregations(records);
    assert.ok(agg.totals.count > 0);
    assert.ok(agg.totals.inputTokens > 0);
    assert.ok(agg.byProvider.length === 2);
    assert.ok(agg.byModel.length > 0);
    assert.ok(agg.byDay.length > 0);
    assert.ok(agg.byProject.length > 0);
  });

  it('generates insights including cache savings', async () => {
    const { records } = await getAllRecords(config);
    const agg = computeAggregations(records);
    const insights = generateInsights(records, agg);
    assert.ok(insights.length >= 2);
    const hasCacheInsight = insights.some(i => i.includes('cache') || i.includes('Cache'));
    if (agg.totals.cacheRead > 0) {
      assert.ok(hasCacheInsight, 'should have cache insight when cache data exists');
    }
  });
});

describe('Edge cases', () => {
  it('handles empty OpenAI config gracefully', () => {
    const { records, warnings } = parseOpenAI({
      openaiUsageFile: '',
      openaiLogsDir: '',
    });
    assert.equal(records.length, 0);
    assert.equal(warnings.length, 0);
  });

  it('preserves zero cost from CSV instead of treating as null', () => {
    const fs = require('fs');
    const tmpFile = path.join(os.tmpdir(), 'costbuster-test-zero-cost.csv');
    fs.writeFileSync(tmpFile, 'date,model,prompt_tokens,completion_tokens,cost_usd\n2025-01-01,gpt-4o,100,50,0.00\n');
    try {
      const { records } = parseOpenAI({ openaiUsageFile: tmpFile, openaiLogsDir: '' });
      assert.equal(records.length, 1);
      assert.equal(records[0].cost, 0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('Config', () => {
  it('resolveHome expands ~ to home directory', () => {
    const result = resolveHome('~/.claude');
    assert.equal(result, path.join(os.homedir(), '.claude'));
  });

  it('resolveHome passes through absolute paths unchanged', () => {
    assert.equal(resolveHome('/usr/local/bin'), '/usr/local/bin');
  });

  it('parseArgs extracts flags correctly', () => {
    const args = parseArgs(['--port', '8080', '--no-open', '--anthropic-dir', '/tmp/data']);
    assert.equal(args.port, '8080');
    assert.equal(args['no-open'], true);
    assert.equal(args['anthropic-dir'], '/tmp/data');
  });

  it('parseArgs recognizes --help', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
  });

  it('loadConfig resolves ~ in openai paths', () => {
    const config = loadConfig(['--openai-file', '~/usage.csv', '--openai-dir', '~/logs']);
    assert.equal(config.openaiUsageFile, path.join(os.homedir(), 'usage.csv'));
    assert.equal(config.openaiLogsDir, path.join(os.homedir(), 'logs'));
  });

  it('loadConfig uses defaults when no args given', { skip: HAS_SAVED_CONFIG && 'Config file exists — saved settings override defaults' }, () => {
    const config = loadConfig([]);
    assert.equal(config.port, 3456);
    assert.equal(config.noOpen, false);
    assert.equal(config.anthropicDataDir, path.join(os.homedir(), '.claude'));
    assert.equal(config.openaiUsageFile, '');
    assert.equal(config.openaiLogsDir, '');
  });

  it('loadConfig rejects invalid port', () => {
    assert.throws(() => loadConfig(['--port', '99999']), /Invalid port/);
    assert.throws(() => loadConfig(['--port', 'abc']), /Invalid port/);
  });
});

describe('Settings', () => {
  const { loadSettings, saveSettings, validatePath, isUnderHome } = require('../src/settings');

  it('loadSettings returns defaults when no config file exists', { skip: HAS_SAVED_CONFIG && 'Config file exists — skipped to avoid env-dependent failure' }, () => {
    const settings = loadSettings();
    assert.ok(settings.anthropicDataDir.endsWith('.claude'));
    assert.equal(settings.openaiUsageFile, '');
    assert.equal(settings.openaiLogsDir, '');
  });

  it('loadSettings always returns only known keys', () => {
    const settings = loadSettings();
    const keys = Object.keys(settings).sort();
    assert.deepStrictEqual(keys, ['anthropicAdminKeys', 'anthropicApiSyncDays', 'anthropicDataDir', 'openaiLogsDir', 'openaiUsageFile']);
  });

  it('validatePath rejects empty path', () => {
    const result = validatePath('');
    assert.equal(result.valid, false);
  });

  it('validatePath rejects nonexistent path', () => {
    const result = validatePath('/this/path/does/not/exist/ever');
    assert.equal(result.valid, false);
  });

  it('validatePath rejects path outside home directory', () => {
    const result = validatePath('/etc');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'Path must be within home directory');
  });

  it('validatePath accepts existing directory under home', () => {
    const result = validatePath(os.homedir());
    assert.equal(result.valid, true);
    assert.equal(result.isDir, true);
  });

  it('validatePath resolves tilde paths', () => {
    const result = validatePath('~');
    assert.equal(result.valid, true);
    assert.equal(result.resolved, os.homedir());
  });

  it('isUnderHome rejects paths outside home', () => {
    assert.equal(isUnderHome('/etc/passwd'), false);
    assert.equal(isUnderHome('/tmp'), false);
  });

  it('isUnderHome accepts paths within home', () => {
    assert.equal(isUnderHome(os.homedir()), true);
    assert.equal(isUnderHome(path.join(os.homedir(), '.claude')), true);
  });

  it('isUnderHome allows empty paths', () => {
    assert.equal(isUnderHome(''), true);
  });
});
