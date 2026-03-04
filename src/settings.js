const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const SETTINGS_DIR = path.join(HOME, '.costbuster');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'config.json');

const DEFAULTS = {
  anthropicDataDir: path.join(HOME, '.claude'),
  anthropicAdminKeys: [],
  anthropicApiSyncDays: 30,
  openaiUsageFile: '',
  openaiLogsDir: '',
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      return {
        anthropicDataDir: saved.anthropicDataDir || DEFAULTS.anthropicDataDir,
        anthropicAdminKeys: Array.isArray(saved.anthropicAdminKeys) ? saved.anthropicAdminKeys : DEFAULTS.anthropicAdminKeys,
        anthropicApiSyncDays: Number.isFinite(saved.anthropicApiSyncDays) ? saved.anthropicApiSyncDays : DEFAULTS.anthropicApiSyncDays,
        openaiUsageFile: saved.openaiUsageFile || DEFAULTS.openaiUsageFile,
        openaiLogsDir: saved.openaiLogsDir || DEFAULTS.openaiLogsDir,
      };
    }
  } catch {
    // Corrupted file — fall back to defaults
  }
  return { ...DEFAULTS };
}

function validateAdminKey(key) {
  return typeof key === 'string' && key.startsWith('sk-ant-admin') && key.length > 20;
}

function maskAdminKey(key) {
  if (!key || key.length < 16) return '***';
  return key.slice(0, 12) + '…' + key.slice(-4);
}

function saveSettings(settings) {
  const rawKeys = Array.isArray(settings.anthropicAdminKeys) ? settings.anthropicAdminKeys : [];
  const validKeys = rawKeys.filter(k => validateAdminKey(k));
  const syncDays = Number.isFinite(settings.anthropicApiSyncDays)
    ? Math.max(1, Math.min(365, settings.anthropicApiSyncDays))
    : DEFAULTS.anthropicApiSyncDays;

  const toSave = {
    anthropicDataDir: settings.anthropicDataDir || DEFAULTS.anthropicDataDir,
    anthropicAdminKeys: validKeys,
    anthropicApiSyncDays: syncDays,
    openaiUsageFile: settings.openaiUsageFile || '',
    openaiLogsDir: settings.openaiLogsDir || '',
  };

  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(toSave, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  return toSave;
}

function resolvePath(p) {
  if (!p) return '';
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : p;
}

function isUnderHome(resolved) {
  if (!resolved) return true;
  try {
    const real = fs.realpathSync(resolved);
    return real === HOME || real.startsWith(HOME + path.sep);
  } catch {
    const normalized = path.resolve(resolved);
    return normalized === HOME || normalized.startsWith(HOME + path.sep);
  }
}

function validatePath(p) {
  if (!p) return { valid: false, reason: 'Path is empty' };
  const resolved = resolvePath(p);
  if (!isUnderHome(resolved)) return { valid: false, reason: 'Path must be within home directory' };
  if (!fs.existsSync(resolved)) return { valid: false, reason: 'Path does not exist' };

  const stat = fs.statSync(resolved);
  return { valid: true, isDir: stat.isDirectory(), resolved };
}

module.exports = { loadSettings, saveSettings, validatePath, isUnderHome, resolvePath, validateAdminKey, maskAdminKey, SETTINGS_FILE };
