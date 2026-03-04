const path = require('path');
const os = require('os');
const { loadSettings } = require('./settings');

function resolveHome(p) {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

function resolveIfSet(p) {
  return p ? resolveHome(p) : '';
}

function loadConfig(argv = []) {
  const args = parseArgs(argv);
  const saved = loadSettings();

  const port = parseInt(args.port || process.env.COSTBUSTER_PORT || '3456', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${args.port || process.env.COSTBUSTER_PORT}`);
  }

  const envKey = process.env.ANTHROPIC_ADMIN_KEY;
  const argKeys = args['anthropic-keys'] ? args['anthropic-keys'].split(',').map(k => k.trim()).filter(Boolean) : [];
  const adminKeys = argKeys.length > 0
    ? argKeys
    : envKey
      ? [...(saved.anthropicAdminKeys || []), envKey]
      : (saved.anthropicAdminKeys || []);

  const syncDays = parseInt(args['sync-days'] || process.env.ANTHROPIC_SYNC_DAYS || '', 10);

  return {
    port,
    noOpen: args['no-open'] || process.env.COSTBUSTER_NO_OPEN === '1',
    anthropicDataDir: resolveHome(
      args['anthropic-dir'] || process.env.ANTHROPIC_DATA_DIR || saved.anthropicDataDir || '~/.claude'
    ),
    anthropicAdminKeys: [...new Set(adminKeys)],
    anthropicApiSyncDays: Number.isFinite(syncDays) && syncDays > 0 ? syncDays : (saved.anthropicApiSyncDays || 30),
    openaiUsageFile: resolveIfSet(
      args['openai-file'] || process.env.OPENAI_USAGE_FILE || saved.openaiUsageFile || ''
    ),
    openaiLogsDir: resolveIfSet(
      args['openai-dir'] || process.env.OPENAI_LOGS_DIR || saved.openaiLogsDir || ''
    ),
  };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--no-open') {
      result['no-open'] = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      result.port = argv[++i];
    } else if (arg === '--anthropic-dir' && i + 1 < argv.length) {
      result['anthropic-dir'] = argv[++i];
    } else if (arg === '--openai-file' && i + 1 < argv.length) {
      result['openai-file'] = argv[++i];
    } else if (arg === '--openai-dir' && i + 1 < argv.length) {
      result['openai-dir'] = argv[++i];
    } else if (arg === '--anthropic-keys' && i + 1 < argv.length) {
      result['anthropic-keys'] = argv[++i];
    } else if (arg === '--sync-days' && i + 1 < argv.length) {
      result['sync-days'] = argv[++i];
    }
  }
  return result;
}

function printHelp() {
  console.log(`
CostBuster — Local dashboard for Anthropic & OpenAI usage costs

Usage:
  costbuster [options]
  npx costbuster [options]

Options:
  --port <number>             Port to listen on (default: 3456, env: COSTBUSTER_PORT)
  --no-open                   Don't auto-open browser
  --anthropic-dir <path>      Anthropic data directory (default: ~/.claude, env: ANTHROPIC_DATA_DIR)
  --anthropic-keys <keys>     Comma-separated Anthropic Admin API keys (env: ANTHROPIC_ADMIN_KEY)
  --sync-days <number>        Days of API history to fetch (default: 30, env: ANTHROPIC_SYNC_DAYS)
  --openai-file <path>        OpenAI usage CSV/JSON file (env: OPENAI_USAGE_FILE)
  --openai-dir <path>         OpenAI API response logs directory (env: OPENAI_LOGS_DIR)
  -h, --help                  Show this help

Examples:
  costbuster
  costbuster --port 8080 --no-open
  costbuster --openai-file ~/openai-usage.csv
  costbuster --anthropic-keys sk-ant-admin-xxx --sync-days 14
`);
}

module.exports = { loadConfig, parseArgs, printHelp, resolveHome };
