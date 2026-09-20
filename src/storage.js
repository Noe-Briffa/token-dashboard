import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function defaultDataDirectory(root) {
  if (process.env.AI_USAGE_DATA_DIR) return process.env.AI_USAGE_DATA_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-usage-monitor', 'data');
  return path.join(root, 'data');
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function nonZeroPricing(row) {
  return ['input_usd_per_million', 'cached_input_usd_per_million', 'output_usd_per_million', 'reasoning_usd_per_million', 'cache_writes_usd_per_million', 'per_minute_usd'].some((key) => Number(row[key]) > 0);
}

const migrationKey = 'migration.electron.v1';
const tableColumns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));

export function mergeLegacyData(target, legacyFile) {
  if (!fs.existsSync(legacyFile) || !hasTable(target, 'app_settings')) return false;
  if (target.prepare('SELECT 1 FROM app_settings WHERE key=?').get(migrationKey)) return false;
  let source;
  try { source = new DatabaseSync(legacyFile, { readOnly: true }); } catch { return false; }
  try {
    target.exec('BEGIN');
    try {
      if (hasTable(source, 'sessions')) {
        const columns = tableColumns(source, 'sessions');
        const value = (row, key, fallback = null) => columns.has(key) && row[key] != null ? row[key] : fallback;
        const insertSession = target.prepare(`INSERT OR IGNORE INTO sessions (id, platform, provider, agent, source_path, project, model, started_at, ended_at, duration_seconds, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, reported_cost_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of source.prepare('SELECT * FROM sessions').all()) {
          insertSession.run(value(row, 'id'), value(row, 'platform', 'codex'), value(row, 'provider'), value(row, 'agent', 'Codex CLI'), value(row, 'source_path', value(row, 'id')), value(row, 'project'), value(row, 'model'), value(row, 'started_at'), value(row, 'ended_at'), value(row, 'duration_seconds', 0), value(row, 'input_tokens', 0), value(row, 'cached_input_tokens', 0), value(row, 'output_tokens', 0), value(row, 'reasoning_tokens', 0), value(row, 'total_tokens', 0), value(row, 'reported_cost_usd'), value(row, 'updated_at', new Date().toISOString()));
        }
      }
      if (hasTable(source, 'model_pricing')) {
        const columns = tableColumns(source, 'model_pricing');
        const value = (row, key, fallback = null) => columns.has(key) && row[key] != null ? row[key] : fallback;
        const upsertPricing = target.prepare(`INSERT INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, cache_writes_usd_per_million, provider, pricing_unit, per_minute_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, model) DO UPDATE SET input_usd_per_million=excluded.input_usd_per_million, cached_input_usd_per_million=excluded.cached_input_usd_per_million, output_usd_per_million=excluded.output_usd_per_million, reasoning_usd_per_million=excluded.reasoning_usd_per_million, cache_writes_usd_per_million=excluded.cache_writes_usd_per_million, provider=excluded.provider, pricing_unit=excluded.pricing_unit, per_minute_usd=excluded.per_minute_usd, updated_at=excluded.updated_at`);
        const currentPricing = target.prepare('SELECT input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, cache_writes_usd_per_million, per_minute_usd, updated_at FROM model_pricing WHERE platform=? AND model=?');
        for (const row of source.prepare('SELECT * FROM model_pricing').all()) {
          row.cache_writes_usd_per_million = value(row, 'cache_writes_usd_per_million', 0);
          row.per_minute_usd = value(row, 'per_minute_usd', 0);
          const platform = value(row, 'platform'), model = value(row, 'model');
          const current = currentPricing.get(platform, model);
          const keepCurrent = current && nonZeroPricing(current) && !nonZeroPricing(row);
          const sourceIsNewer = !current || String(row.updated_at || '') >= String(current.updated_at || '');
          if (!keepCurrent && (sourceIsNewer || (current && !nonZeroPricing(current) && nonZeroPricing(row)))) {
            upsertPricing.run(platform, model, value(row, 'input_usd_per_million', 0), value(row, 'cached_input_usd_per_million', 0), value(row, 'output_usd_per_million', 0), value(row, 'reasoning_usd_per_million', 0), row.cache_writes_usd_per_million, value(row, 'provider'), value(row, 'pricing_unit', 'per_1M_tokens'), row.per_minute_usd, value(row, 'updated_at', new Date().toISOString()));
          }
        }
      }
      if (hasTable(source, 'limits_history')) {
        const insertHistory = target.prepare('INSERT OR IGNORE INTO limits_history (taken_at, plan, primary_remaining, secondary_remaining) VALUES (?, ?, ?, ?)');
        for (const row of source.prepare('SELECT taken_at, plan, primary_remaining, secondary_remaining FROM limits_history').all()) insertHistory.run(row.taken_at, row.plan, row.primary_remaining, row.secondary_remaining);
      }
      if (hasTable(source, 'app_settings')) {
        const currentSetting = target.prepare('SELECT value FROM app_settings WHERE key=?');
        const upsertSetting = target.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
        const defaultSettings = new Set(['codex_desktop_subscription', 'openai_subscription']);
        for (const row of source.prepare('SELECT key, value FROM app_settings').all()) {
          const current = currentSetting.get(row.key);
          if (!current || (defaultSettings.has(row.key) && current.value === 'true')) upsertSetting.run(row.key, row.value);
        }
      }
      target.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(migrationKey, new Date().toISOString());
      target.exec('COMMIT');
    } catch (error) { try { target.exec('ROLLBACK'); } catch {} throw error; }
  } finally { source.close(); }
  return true;
}
