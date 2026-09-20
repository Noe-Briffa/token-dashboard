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
  return ['input_usd_per_million', 'cached_input_usd_per_million', 'output_usd_per_million', 'reasoning_usd_per_million'].some((key) => Number(row[key]) > 0);
}

export function mergeLegacyData(target, legacyFile) {
  if (!fs.existsSync(legacyFile)) return;
  let source;
  try { source = new DatabaseSync(legacyFile, { readOnly: true }); } catch { return; }
  try {
    target.exec('BEGIN');
    try {
      if (hasTable(source, 'sessions')) {
        const insertSession = target.prepare(`INSERT OR IGNORE INTO sessions (id, platform, provider, agent, source_path, project, model, started_at, ended_at, duration_seconds, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, reported_cost_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const row of source.prepare('SELECT id, platform, provider, agent, source_path, project, model, started_at, ended_at, duration_seconds, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, reported_cost_usd, updated_at FROM sessions').all()) {
          insertSession.run(row.id, row.platform, row.provider, row.agent, row.source_path, row.project, row.model, row.started_at, row.ended_at, row.duration_seconds, row.input_tokens, row.cached_input_tokens, row.output_tokens, row.reasoning_tokens, row.total_tokens, row.reported_cost_usd, row.updated_at);
        }
      }
      if (hasTable(source, 'model_pricing')) {
        const upsertPricing = target.prepare(`INSERT INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, provider, pricing_unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, model) DO UPDATE SET input_usd_per_million=excluded.input_usd_per_million, cached_input_usd_per_million=excluded.cached_input_usd_per_million, output_usd_per_million=excluded.output_usd_per_million, reasoning_usd_per_million=excluded.reasoning_usd_per_million, provider=excluded.provider, pricing_unit=excluded.pricing_unit, updated_at=excluded.updated_at`);
        const currentPricing = target.prepare('SELECT input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, updated_at FROM model_pricing WHERE platform=? AND model=?');
        for (const row of source.prepare('SELECT platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, provider, pricing_unit, updated_at FROM model_pricing').all()) {
          const current = currentPricing.get(row.platform, row.model);
          const keepCurrent = current && nonZeroPricing(current) && !nonZeroPricing(row);
          const sourceIsNewer = !current || String(row.updated_at || '') >= String(current.updated_at || '');
          if (!keepCurrent && (sourceIsNewer || (current && !nonZeroPricing(current) && nonZeroPricing(row)))) {
            upsertPricing.run(row.platform, row.model, row.input_usd_per_million, row.cached_input_usd_per_million, row.output_usd_per_million, row.reasoning_usd_per_million, row.provider, row.pricing_unit, row.updated_at);
          }
        }
      }
      if (hasTable(source, 'limits_history')) {
        const insertHistory = target.prepare('INSERT OR IGNORE INTO limits_history (taken_at, plan, primary_remaining, secondary_remaining) VALUES (?, ?, ?, ?)');
        for (const row of source.prepare('SELECT taken_at, plan, primary_remaining, secondary_remaining FROM limits_history').all()) insertHistory.run(row.taken_at, row.plan, row.primary_remaining, row.secondary_remaining);
      }
      target.exec('COMMIT');
    } catch (error) { try { target.exec('ROLLBACK'); } catch {} throw error; }
  } finally { source.close(); }
}
