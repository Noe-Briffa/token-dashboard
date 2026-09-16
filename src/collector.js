import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

export const defaultCodexRoot = () => path.join(os.homedir(), '.codex', 'sessions');
export const defaultOpenCodeDatabase = () => path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, source_path TEXT NOT NULL UNIQUE,
      project TEXT, model TEXT, started_at TEXT, ended_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL, updated_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
  if (!columns.has('platform')) db.exec("ALTER TABLE sessions ADD COLUMN platform TEXT NOT NULL DEFAULT 'codex'");
  if (!columns.has('reported_cost_usd')) db.exec('ALTER TABLE sessions ADD COLUMN reported_cost_usd REAL');
  if (!columns.has('provider')) db.exec('ALTER TABLE sessions ADD COLUMN provider TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_pricing (
      platform TEXT NOT NULL, model TEXT NOT NULL,
      input_usd_per_million REAL NOT NULL DEFAULT 0,
      cached_input_usd_per_million REAL NOT NULL DEFAULT 0,
      output_usd_per_million REAL NOT NULL DEFAULT 0,
      reasoning_usd_per_million REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (platform, model)
    );
    CREATE INDEX IF NOT EXISTS sessions_started_at ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS sessions_platform_model ON sessions(platform, model);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('codex_desktop_subscription', 'true');
    INSERT OR IGNORE INTO app_settings (key, value) SELECT 'openai_subscription', value FROM app_settings WHERE key='codex_desktop_subscription';
    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('openai_subscription', 'true');
  `);
  const pricingCols = new Set(db.prepare('PRAGMA table_info(model_pricing)').all().map((c) => c.name));
  if (!pricingCols.has('cache_writes_usd_per_million')) db.exec('ALTER TABLE model_pricing ADD COLUMN cache_writes_usd_per_million REAL');
  if (!pricingCols.has('provider')) db.exec('ALTER TABLE model_pricing ADD COLUMN provider TEXT');
  if (!pricingCols.has('pricing_unit')) db.exec("ALTER TABLE model_pricing ADD COLUMN pricing_unit TEXT NOT NULL DEFAULT 'per_1M_tokens'");
  if (!pricingCols.has('per_minute_usd')) db.exec('ALTER TABLE model_pricing ADD COLUMN per_minute_usd REAL');
  db.exec("DELETE FROM model_pricing WHERE platform='opencode' AND model LIKE '{%\"id\"%'");
  // seed / fix Muse Spark 1.2 Contributor: $0.10 in / $0.002 cached / $0.20 out (Contributor tier, Meta)
  try {
    for (const p of ['codex','opencode']) {
      db.prepare("INSERT OR IGNORE INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, provider, pricing_unit, updated_at) VALUES (?, 'muse-spark-1.2-contributor-free', 0.10, 0.002, 0.20, 0.20, 'meta', 'per_1M_tokens', datetime('now'))").run(p);
      db.prepare("UPDATE model_pricing SET input_usd_per_million=0.10, cached_input_usd_per_million=0.002, output_usd_per_million=0.20, reasoning_usd_per_million=0.20, provider='meta', pricing_unit='per_1M_tokens', updated_at=datetime('now') WHERE platform=? AND model='muse-spark-1.2-contributor-free' AND input_usd_per_million=0 AND output_usd_per_million=0").run(p);
    }
  } catch {}
  // fix historic opencode totals that excluded cached reads (total = input+output+reasoning)
  try { db.exec("UPDATE sessions SET total_tokens = input_tokens + cached_input_tokens + output_tokens + reasoning_tokens WHERE platform='opencode' AND total_tokens = input_tokens + output_tokens + reasoning_tokens AND cached_input_tokens > 0"); } catch {}
  return db;
}

function filesUnder(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(item);
    }
  };
  visit(root);
  return found;
}

const integer = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const timestampMs = (value) => Number.isNaN(Date.parse(value || '')) ? null : Date.parse(value);

// Contract shared by current Codex collector and future OpenCode/Claude collectors.
export function normalizeSession(session) {
  return {
    platform: session.platform, provider: session.provider || null, agent: session.agent, id: session.id, sourcePath: session.sourcePath,
    project: session.project || null, model: session.model || null, startedAt: session.startedAt || null,
    endedAt: session.endedAt || null, durationSeconds: integer(session.durationSeconds),
    input: integer(session.input), cached: integer(session.cached), output: integer(session.output),
    reasoning: integer(session.reasoning), total: integer(session.total),
    reportedCost: session.reportedCost == null || session.reportedCost === '' ? null : (Number.isFinite(Number(session.reportedCost)) ? Number(session.reportedCost) : null)
  };
}

export function parseCodexSession(file) {
  let meta = {}, startedAt = null, endedAt = null;
  let usage = { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
  const modelSeq = [];
  let currentModel = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const stamp = record.timestamp;
    if (stamp && (!startedAt || stamp < startedAt)) startedAt = stamp;
    if (stamp && (!endedAt || stamp > endedAt)) endedAt = stamp;
    if (record.type === 'session_meta') meta = record.payload || {};
    if (record.type === 'turn_context' && record.payload?.model) {
      currentModel = record.payload.model;
      if (!modelSeq.includes(currentModel)) modelSeq.push(currentModel);
    }
    const candidate = record.payload?.info?.total_token_usage;
    if (candidate && integer(candidate.total_tokens) >= usage.total) {
      usage = { input: integer(candidate.input_tokens), cached: integer(candidate.cached_input_tokens), output: integer(candidate.output_tokens), reasoning: integer(candidate.reasoning_output_tokens), total: integer(candidate.total_tokens) };
    }
  }
  const sessionStart = meta.timestamp || startedAt;
  const start = timestampMs(sessionStart), end = timestampMs(endedAt);
  const base = {
    platform: 'codex', provider: 'openai', id: meta.session_id || meta.id || path.basename(file, '.jsonl'),
    agent: meta.originator === 'Codex Desktop' ? 'Codex Desktop' : 'Codex CLI', sourcePath: file,
    project: meta.cwd, startedAt: sessionStart, endedAt,
    durationSeconds: start && end ? Math.max(0, Math.round((end - start) / 1000)) : 0,
  };
  // ventilation exacte: if multiple models, split tokens per model by turn count (best-effort without per-turn deltas)
  if (modelSeq.length > 1) {
    const per = Math.floor(usage.total / modelSeq.length);
    const remainder = usage.total - per * modelSeq.length;
    return modelSeq.map((m, idx) => normalizeSession({
      ...base,
      id: `${base.id}:${m}`,
      sourcePath: `${file}:${m}`,
      model: m,
      input: Math.floor(usage.input / modelSeq.length),
      cached: Math.floor(usage.cached / modelSeq.length),
      output: Math.floor(usage.output / modelSeq.length),
      reasoning: Math.floor(usage.reasoning / modelSeq.length),
      total: per + (idx === 0 ? remainder : 0),
    }));
  }
  return normalizeSession({
    ...base,
    model: currentModel || meta.model || modelSeq[0] || null,
    ...usage,
  });
}

export function importSessions(db, sessions) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, platform, provider, agent, source_path, project, model, started_at, ended_at, duration_seconds, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, reported_cost_usd, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let imported = 0;
  for (const raw of sessions) {
    const item = normalizeSession(raw);
    upsert.run(item.id, item.platform, item.provider, item.agent, item.sourcePath, item.project, item.model, item.startedAt, item.endedAt, item.durationSeconds, item.input, item.cached, item.output, item.reasoning, item.total, item.reportedCost, new Date().toISOString());
    imported++;
  }
  return imported;
}

export function collectCodex(db, { root = defaultCodexRoot() } = {}) {
  const sessions = filesUnder(root).flatMap((f) => {
    const r = parseCodexSession(f);
    return Array.isArray(r) ? r : [r];
  });
  const imported = importSessions(db, sessions);
  return { imported, source: root, platform: 'codex' };
}

const iso = (milliseconds) => Number.isFinite(Number(milliseconds)) ? new Date(Number(milliseconds)).toISOString() : null;

export function collectOpenCode(db, { file = defaultOpenCodeDatabase() } = {}) {
  if (!fs.existsSync(file)) return { imported: 0, source: file, platform: 'opencode', status: 'not_connected' };
  let source;
  try {
    source = new DatabaseSync(file, { readOnly: true });
    const rows = source.prepare(`
      SELECT s.id, s.directory, s.agent, s.model, s.cost, s.time_created, s.time_updated,
        s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, p.name project_name
      FROM session s LEFT JOIN project p ON p.id=s.project_id
    `).all();
    const hasMessage = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'").get();
    const sessions = rows.flatMap((row) => {
      let model = row.model, modelMeta = null;
      try { modelMeta = JSON.parse(row.model); model = modelMeta.id || row.model; } catch { /* OpenCode may store plain model ID. */ }
      const base = {
        platform: 'opencode', provider: modelMeta?.providerID || null,
        agent: row.agent || 'OpenCode', project: row.project_name || row.directory,
        startedAt: iso(row.time_created), endedAt: iso(row.time_updated),
        durationSeconds: Math.max(0, Math.round((Number(row.time_updated || 0) - Number(row.time_created || 0)) / 1000)),
        reportedCost: row.cost,
      };
      // ventilation exacte: aggregate message tokens per modelID + per Paris day (session peut s'étaler sur plusieurs jours)
      if (hasMessage) {
        try {
          const msgs = source.prepare("SELECT data FROM message WHERE session_id=?").all(row.id);
          if (msgs.length) {
            // clean old ids for this session (migration vers per-day)
            try { db.prepare("DELETE FROM sessions WHERE id = ? OR id LIKE ?").run(`opencode:${row.id}`, `opencode:${row.id}:%`); } catch {}
            const perDayModel = new Map();
            for (const m of msgs) {
              let data; try { data = JSON.parse(m.data); } catch { continue; }
              const mid = data.modelID || model;
              const prov = data.providerID || base.provider;
              const t = data.tokens || {};
              const ts = data.time?.created || data.time?.completed || row.time_created;
              const localDay = ts ? new Date(Number(ts)).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) : null;
              const key = localDay ? `${mid}__${localDay}` : mid;
              const cur = perDayModel.get(key) || { provider: prov, model: mid, day: localDay, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
              cur.provider = prov || cur.provider;
              cur.input += integer(t.input);
              cur.cached += integer(t.cache?.read);
              cur.output += integer(t.output);
              cur.reasoning += integer(t.reasoning);
              cur.total += integer(t.total || (integer(t.input)+integer(t.cache?.read)+integer(t.output)+integer(t.reasoning)));
              perDayModel.set(key, cur);
            }
            if (perDayModel.size) {
              return [...perDayModel.values()].map((agg) => {
                const day = agg.day || iso(row.time_created)?.slice(0,10);
                const id = agg.day ? `opencode:${row.id}:${agg.model}:${agg.day}` : `opencode:${row.id}:${agg.model}`;
                const startedAt = agg.day ? new Date(`${agg.day}T12:00:00+02:00`).toISOString() : base.startedAt;
                const endedAt = startedAt;
                return normalizeSession({
                  ...base, provider: agg.provider, id, sourcePath: id,
                  model: agg.model, startedAt, endedAt,
                  input: agg.input, cached: agg.cached, output: agg.output, reasoning: agg.reasoning, total: agg.total || agg.input+agg.cached+agg.output+agg.reasoning,
                });
              });
            }
          }
        } catch { /* fallback to session aggregate */ }
      }
      return [normalizeSession({
        ...base, id: `opencode:${row.id}`, sourcePath: `opencode:${row.id}`,
        model, input: row.tokens_input, cached: row.tokens_cache_read, output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        total: integer(row.tokens_input) + integer(row.tokens_cache_read) + integer(row.tokens_output) + integer(row.tokens_reasoning),
      })];
    });
    return { imported: importSessions(db, sessions), source: file, platform: 'opencode', status: 'connected' };
  } catch (error) {
    return { imported: 0, source: file, platform: 'opencode', status: 'not_connected', error: error.message };
  } finally { source?.close(); }
}
