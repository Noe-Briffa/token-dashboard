import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const defaultCodexRoot = () => path.join(os.homedir(), '.codex', 'sessions');
export const defaultCodexAuth = () => path.join(os.homedir(), '.codex', 'auth.json');
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
      model_calls INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL, updated_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name));
  if (!columns.has('platform')) db.exec("ALTER TABLE sessions ADD COLUMN platform TEXT NOT NULL DEFAULT 'codex'");
  if (!columns.has('reported_cost_usd')) db.exec('ALTER TABLE sessions ADD COLUMN reported_cost_usd REAL');
  if (!columns.has('provider')) db.exec('ALTER TABLE sessions ADD COLUMN provider TEXT');
  if (!columns.has('model_calls')) db.exec('ALTER TABLE sessions ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0');
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
    CREATE TABLE IF NOT EXISTS limits_history (
      taken_at TEXT PRIMARY KEY, plan TEXT,
      primary_remaining REAL, secondary_remaining REAL
    );
    CREATE INDEX IF NOT EXISTS limits_history_taken_at ON limits_history(taken_at);
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS opencode_skill_events (
      id TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      skill TEXT NOT NULL,
      agent TEXT,
      time_created INTEGER NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS opencode_skill_events_day ON opencode_skill_events(day);
    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('codex_desktop_subscription', 'true');
    INSERT OR IGNORE INTO app_settings (key, value) SELECT 'openai_subscription', value FROM app_settings WHERE key='codex_desktop_subscription';
    INSERT OR IGNORE INTO app_settings (key, value) VALUES ('openai_subscription', 'true');
  `);
  const pricingCols = new Set(db.prepare('PRAGMA table_info(model_pricing)').all().map((c) => c.name));
  if (!pricingCols.has('cache_writes_usd_per_million')) db.exec('ALTER TABLE model_pricing ADD COLUMN cache_writes_usd_per_million REAL');
  if (!pricingCols.has('provider')) db.exec('ALTER TABLE model_pricing ADD COLUMN provider TEXT');
  if (!pricingCols.has('pricing_unit')) db.exec("ALTER TABLE model_pricing ADD COLUMN pricing_unit TEXT NOT NULL DEFAULT 'per_1M_tokens'");
  if (!pricingCols.has('per_minute_usd')) db.exec('ALTER TABLE model_pricing ADD COLUMN per_minute_usd REAL');
  if (!pricingCols.has('color')) db.exec('ALTER TABLE model_pricing ADD COLUMN color TEXT');
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
  return found.sort();
}

function statSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${stat.mtimeMs}`;
  } catch { return `${file}:missing`; }
}

function sourceSignature(files) {
  return files.map(statSignature).join('|');
}

function openCodeSignature(file) {
  const main = fs.statSync(file);
  let walSize = 0;
  try { walSize = fs.statSync(`${file}-wal`).size; } catch {}
  return `${file}:${main.size}:${main.mtimeMs}:wal:${walSize}`;
}

function readLinesSync(file, onLine) {
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let remainder = '';
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      const lines = `${remainder}${buffer.subarray(0, bytesRead).toString('utf8')}`.split(/\r?\n/);
      remainder = lines.pop() || '';
      for (const line of lines) onLine(line);
    }
    if (remainder) onLine(remainder);
  } finally { fs.closeSync(descriptor); }
}

const integer = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const timestampMs = (value) => Number.isNaN(Date.parse(value || '')) ? null : Date.parse(value);
const parisHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' });
const codexCaches = new WeakMap();
const openCodeCaches = new WeakMap();
const openCodeSkillCaches = new WeakMap();
const OPEN_CODE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Contract shared by current Codex collector and future OpenCode/Claude collectors.
export function normalizeSession(session) {
  return {
    platform: session.platform, provider: session.provider || null, agent: session.agent, id: session.id, sourcePath: session.sourcePath,
    project: session.project || null, model: session.model || null, startedAt: session.startedAt || null,
    endedAt: session.endedAt || null, durationSeconds: integer(session.durationSeconds),
    input: integer(session.input), cached: integer(session.cached), output: integer(session.output),
    reasoning: integer(session.reasoning), total: integer(session.total),
    modelCalls: integer(session.modelCalls),
    reportedCost: session.reportedCost == null || session.reportedCost === '' ? null : (Number.isFinite(Number(session.reportedCost)) ? Number(session.reportedCost) : null)
  };
}

// Exception demandée : ce handoff ChatGPT appartient à ePortfolio (aucune métadonnée Codex ne le dit).
const PROJECT_OVERRIDES = [
  ['referenced-chatgpt-conversation-this-is-an', 'C:\\Users\\noebr\\Documents\\Documents\\Projets\\ePortfolio'],
];
const applyProjectOverride = (project) => {
  if (!project) return project;
  const hit = PROJECT_OVERRIDES.find(([match]) => project.includes(match));
  return hit ? hit[1] : project;
};

export function parseCodexSession(file) {
  let meta = {}, startedAt = null, endedAt = null;
  const snap = (candidate) => ({ input: integer(candidate.input_tokens), cached: integer(candidate.cached_input_tokens), output: integer(candidate.output_tokens), reasoning: integer(candidate.reasoning_output_tokens), total: integer(candidate.total_tokens) });
  const modelSeq = [];
  let currentModel = null;
  const buckets = new Map();
  let previous = null;
  readLinesSync(file, (line) => {
    if (!line) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const stamp = record.timestamp;
    if (stamp && (!startedAt || stamp < startedAt)) startedAt = stamp;
    if (stamp && (!endedAt || stamp > endedAt)) endedAt = stamp;
    if (record.type === 'session_meta') meta = record.payload || {};
    if (record.type === 'turn_context' && record.payload?.model) {
      currentModel = record.payload.model;
      if (!modelSeq.includes(currentModel)) modelSeq.push(currentModel);
    }
    const candidate = record.payload?.info?.total_token_usage;
    if (!candidate) return;
    const snapshot = { stamp, usage: snap(candidate), model: currentModel };
    if (!previous) { previous = snapshot; return; }
    if (snapshot.usage.total < previous.usage.total) { previous = snapshot; return; }
    const day = snapshot.stamp ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(snapshot.stamp)) : null;
    const hour = snapshot.stamp ? parisHour.format(new Date(snapshot.stamp)) : null;
    const key = `${day || 'unknown'}\u0000${hour || ''}\u0000${snapshot.model || ''}`;
     const delta = buckets.get(key) || { day, hour, model: snapshot.model, firstAt: snapshot.stamp, lastAt: snapshot.stamp, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, calls: 0 };
    delta.firstAt = delta.firstAt || snapshot.stamp;
    delta.lastAt = snapshot.stamp || delta.lastAt;
    for (const field of ['input', 'cached', 'output', 'reasoning', 'total']) delta[field] += Math.max(0, snapshot.usage[field] - previous.usage[field]);
    buckets.set(key, delta);
    previous = snapshot;
  });
  const stem = path.basename(file, '.jsonl'); // rollout-<ts>-<uuid>[_<fork>]
  const fork = stem.includes('_') ? stem.slice(stem.lastIndexOf('_') + 1) : '';
  const sessionId = meta.session_id || meta.id || stem;
  const fileId = fork ? `${sessionId}~${fork}` : sessionId; // ids scopés au fichier : deltas disjoints, pas de collision
  const fallbackModel = currentModel || meta.model || (modelSeq.length === 1 ? modelSeq[0] : null);
  const relabeledBuckets = new Map();
  for (const bucket of buckets.values()) {
    bucket.model ||= fallbackModel;
    const key = `${bucket.day || 'unknown'}\u0000${bucket.hour || ''}\u0000${bucket.model || ''}`;
    const current = relabeledBuckets.get(key);
    if (!current) relabeledBuckets.set(key, bucket);
    else for (const field of ['input', 'cached', 'output', 'reasoning', 'total']) current[field] += bucket[field];
  }
  const finalBuckets = relabeledBuckets;
  const base = { platform: 'codex', provider: 'openai', agent: meta.originator === 'Codex Desktop' ? 'Codex Desktop' : 'Codex CLI', project: applyProjectOverride(meta.cwd), sourcePath: file };
  if (!finalBuckets.size) return normalizeSession({ ...base, id: fileId, model: fallbackModel, startedAt: meta.timestamp || startedAt, endedAt });
  return [...finalBuckets.values()].map((bucket) => {
    const isSingle = finalBuckets.size === 1;
    const dayStamp = bucket.day ? new Date(`${bucket.day}T12:00:00Z`).toISOString() : (meta.timestamp || startedAt);
    const id = isSingle ? fileId : `${fileId}:${bucket.day || 'unknown'}${bucket.hour ? `:${bucket.hour}` : ''}${bucket.model ? `:${bucket.model}` : ''}`;
    const start = timestampMs(bucket.firstAt), end = timestampMs(bucket.lastAt);
    return normalizeSession({
      ...base, id, sourcePath: isSingle ? file : `${file}:${bucket.day || 'unknown'}:${bucket.hour || 'unknown'}:${bucket.model || 'unknown'}`,
      model: bucket.model, startedAt: bucket.firstAt || dayStamp, endedAt: bucket.lastAt || dayStamp,
      durationSeconds: start && end ? Math.max(0, Math.round((end - start) / 1000)) : 0,
      input: bucket.input, cached: bucket.cached, output: bucket.output, reasoning: bucket.reasoning, total: bucket.total, modelCalls: bucket.calls,
    });
  });
}

export function importSessions(db, sessions) {
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO sessions (id, platform, provider, agent, source_path, project, model, started_at, ended_at, duration_seconds, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, model_calls, reported_cost_usd, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let imported = 0;
  const seen = new Set();
  const ensurePricing = db.prepare("INSERT OR IGNORE INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, pricing_unit, updated_at) VALUES (?, ?, 0, 0, 0, 0, 'per_1M_tokens', datetime('now'))");
  for (const raw of sessions) {
    const item = normalizeSession(raw);
    upsert.run(item.id, item.platform, item.provider, item.agent, item.sourcePath, item.project, item.model, item.startedAt, item.endedAt, item.durationSeconds, item.input, item.cached, item.output, item.reasoning, item.total, item.modelCalls, item.reportedCost, new Date().toISOString());
    imported++;
    // nouveau modèle utilisé => ligne prix à saisir, jamais de doublon (INSERT OR IGNORE)
    const key = `${item.platform}__${item.model}`;
    if (item.model && !seen.has(key)) { seen.add(key); ensurePricing.run(item.platform, item.model); }
  }
  return imported;
}

function runIsolatedCollector(mode, source, args = []) {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-worker.mjs');
  const child = spawnSync(process.execPath, [worker, mode, source, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr.trim() || `${mode} worker exited with ${child.status}`);
  return JSON.parse(child.stdout);
}

function runIsolatedCollectorAsync(mode, source, timeoutMs = 120000, args = []) {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-worker.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, mode, source, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : process.env.ELECTRON_RUN_AS_NODE },
      windowsHide: true,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${mode} worker timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) return reject(new Error(stderr.trim() || `${mode} worker exited with ${status}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

function importIsolatedProjection(db, payload, platform) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM sessions WHERE platform=?').run(platform);
    const imported = importSessions(db, payload.sessions);
    const skillEventsImported = platform === 'opencode' ? importOpenCodeSkillEvents(db, payload.skillEvents) : 0;
    db.exec('COMMIT');
    return { ...payload.result, imported, skillEventsImported, skills: payload.skills || [] };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function collectCodex(db, { root = defaultCodexRoot(), isolated = false } = {}) {
  const files = filesUnder(root);
  const signature = sourceSignature(files), cache = codexCaches.get(db) || { root, signature: null, files: new Map() };
  if (cache.root === root && cache.signature === signature) return { ...cache.result, imported: 0, skipped: true };
  cache.root = root;
  if (isolated) {
    try {
      const result = importIsolatedProjection(db, runIsolatedCollector('codex', root), 'codex');
      cache.signature = signature;
      cache.result = result;
      codexCaches.set(db, cache);
      return result;
    } catch (error) {
      return { imported: 0, source: root, platform: 'codex', status: 'not_connected', error: error.message };
    }
  }
  for (const file of files) {
    const fileSignature = statSignature(file), previous = cache.files.get(file);
    if (!previous || previous.signature !== fileSignature) {
      const parsed = parseCodexSession(file);
      cache.files.set(file, { signature: fileSignature, sessions: Array.isArray(parsed) ? parsed : [parsed] });
    }
  }
  for (const file of cache.files.keys()) if (!files.includes(file)) cache.files.delete(file);
  const parsed = [...cache.files.values()].flatMap(({ sessions }) => sessions);
  const sourceSessions = new Set(parsed.filter(Boolean).map((row) => row.id.split('~')[0].split(':')[0]));
  const sessions = parsed.filter((r) => r && (r.total || r.input || r.output || r.reasoning || r.cached)); // fichiers fantômes (delta 0) hors table
  db.exec('BEGIN');
  try {
    // Reconstruction complète : les fichiers (deltas disjoints, ids scopés) sont la vérité terrain.
    // Zéro fichier => on ne touche à rien (jamais de perte si ~/.codex absent).
    if (files.length) db.prepare("DELETE FROM sessions WHERE platform='codex'").run();
    const imported = importSessions(db, sessions);
    db.exec('COMMIT');
    const result = { imported, sourceSessions: sourceSessions.size, source: root, platform: 'codex' };
    cache.signature = signature;
    cache.result = result;
    codexCaches.set(db, cache);
    return result;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

export async function collectCodexAsync(db, { root = defaultCodexRoot() } = {}) {
  const files = filesUnder(root);
  const signature = sourceSignature(files), cache = codexCaches.get(db) || { root, signature: null, files: new Map() };
  if (cache.root === root && cache.signature === signature) return { ...cache.result, imported: 0, skipped: true };
  cache.root = root;
  if (!files.length) return { imported: 0, source: root, platform: 'codex', sourceSessions: 0 };
  try {
    const result = importIsolatedProjection(db, await runIsolatedCollectorAsync('codex', root), 'codex');
    cache.signature = signature;
    cache.result = result;
    codexCaches.set(db, cache);
    return result;
  } catch (error) {
    return { imported: 0, source: root, platform: 'codex', status: 'not_connected', error: error.message };
  }
}

const iso = (milliseconds) => Number.isFinite(Number(milliseconds)) ? new Date(Number(milliseconds)).toISOString() : null;
const parisDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' });

export function parseOpenCodeSkillEvents(rows) {
  return rows.flatMap((row) => {
    const skill = String(row.skill || '').trim();
    const timestamp = Number(row.time_created);
    if (!row.id || !skill || !Number.isFinite(timestamp)) return [];
    return [{ id: row.id, day: parisDate.format(new Date(timestamp)), skill, agent: String(row.agent || '').trim() || null, time_created: timestamp }];
  });
}

export function parseOpenCodeSkills(rows) {
  const counts = new Map();
  for (const row of parseOpenCodeSkillEvents(rows.map((item, index) => ({ id: item.id || `row-${index}`, ...item })))) {
    const key = `${row.day}\u0000${row.skill}\u0000${row.agent || ''}`;
    const current = counts.get(key) || { day: row.day, skill: row.skill, agent: row.agent, activations: 0 };
    current.activations++;
    counts.set(key, current);
  }
  return [...counts.values()].sort((a, b) => a.day.localeCompare(b.day) || b.activations - a.activations || a.skill.localeCompare(b.skill));
}

function readOpenCodeSkillEventsFromDatabase(source, sinceMs = 0) {
  const hasPart = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='part'").get();
  if (!hasPart) return [];
  const rows = source.prepare(`
    SELECT p.id, p.time_created, s.agent, json_extract(p.data, '$.state.input.name') skill
    FROM part p LEFT JOIN session s ON s.id=p.session_id
    WHERE json_valid(p.data)
      AND json_extract(p.data, '$.type') = 'tool'
      AND json_extract(p.data, '$.tool') = 'skill'
      AND json_extract(p.data, '$.state.status') = 'completed'
      AND p.time_created >= ?
  `).all(Number(sinceMs) || 0);
  return parseOpenCodeSkillEvents(rows);
}

function readOpenCodeSkillsFromDatabase(source, sinceMs = 0) {
  return parseOpenCodeSkills(readOpenCodeSkillEventsFromDatabase(source, sinceMs));
}

export function importOpenCodeSkillEvents(db, events, importedAt = new Date().toISOString()) {
  const insert = db.prepare('INSERT OR IGNORE INTO opencode_skill_events (id, day, skill, agent, time_created, imported_at) VALUES (?, ?, ?, ?, ?, ?)');
  let imported = 0;
  for (const event of events || []) {
    const result = insert.run(event.id, event.day, event.skill, event.agent || null, event.time_created, importedAt);
    imported += Number(result.changes) || 0;
  }
  return imported;
}

export function readOpenCodeSkillEvents(file = defaultOpenCodeDatabase(), sinceMs = 0) {
  if (!fs.existsSync(file)) return [];
  let source;
  try {
    source = new DatabaseSync(file, { readOnly: true });
    return readOpenCodeSkillEventsFromDatabase(source, sinceMs);
  } catch { return []; }
  finally { source?.close(); }
}

export function readOpenCodeSkills(file = defaultOpenCodeDatabase(), sinceMs = 0) {
  return parseOpenCodeSkills(readOpenCodeSkillEvents(file, sinceMs));
}

// Limites Codex temps réel (fenêtre 5h + hebdo) via backend ChatGPT.
// Contrat : normalizeLimits(payload) pur et testable ; collectCodexLimits() fait IO + cache.
export function normalizeLimits(payload) {
  const remaining = (window) => {
    if (!window || !Number.isFinite(Number(window.used_percent))) return null;
    const used = Math.min(100, Math.max(0, Number(window.used_percent)));
    const at = Number(window.reset_at) * 1000;
    return { remaining: 100 - used, resetsAt: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null };
  };
  const rate = payload?.rate_limit || {};
  const primary = remaining(rate.primary_window), secondary = remaining(rate.secondary_window);
  if (!primary && !secondary) return { status: 'empty', plan: payload?.plan_type || null, primary: null, secondary: null };
  return { status: 'connected', plan: payload?.plan_type || null, primary, secondary };
}

let limitsCache = null; // ponytail: mémoire seule, un fetch / 5 min max, pas de table
let lastGoodLimits = null; // dernier succès, réaffiché en grisé en cas d'échec
export async function collectCodexLimits({ authFile = defaultCodexAuth(), cacheMs = 300000, fetchImpl = fetch, now = Date.now() } = {}) {
  if (limitsCache) {
    const failureTtl = limitsCache.data.status === 'connected' ? cacheMs : Math.min(cacheMs, 30000);
    if (now - limitsCache.at < failureTtl) return limitsCache.data;
  }
  const fail = (status, reason = null) => {
    const data = { status, reason, plan: lastGoodLimits?.plan || null, primary: lastGoodLimits?.primary || null, secondary: lastGoodLimits?.secondary || null, fetchedAt: lastGoodLimits?.fetchedAt || null };
    limitsCache = { at: now, data };
    return data;
  };
  let auth;
  try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return fail('not_connected'); }
  const token = auth?.tokens?.access_token, accountId = auth?.tokens?.account_id;
  if (auth?.auth_mode !== 'chatgpt' || !token) return fail(auth?.OPENAI_API_KEY ? 'not_applicable' : 'not_connected');
  try {
    const response = await fetchImpl('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${token}`, ...(accountId ? { 'ChatGPT-Account-ID': accountId } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) return fail('auth_expired');
    if (response.status === 429) return fail('rate_limited');
    if (!response.ok) return fail('service');
    let data;
    try { data = { ...normalizeLimits(await response.json()), fetchedAt: new Date(now).toISOString() }; }
    catch { return fail('service'); }
    limitsCache = { at: now, data };
    if (data.status === 'connected') lastGoodLimits = data;
    return data;
  } catch (error) {
    const cause = error?.cause || error;
    const code = cause?.code || error?.code;
    const reason = error?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout'
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns'
        : code === 'CERT_HAS_EXPIRED' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? 'tls'
          : code === 'ECONNRESET' || code === 'ECONNREFUSED' ? 'connection' : 'unknown';
    return fail('network', reason);
  }
}

export function recordLimitsHistory(db, limits, now = Date.now()) {
  if (!limits || limits.status !== 'connected') return 0;
  const last = db.prepare('SELECT taken_at FROM limits_history ORDER BY taken_at DESC LIMIT 1').get();
  if (last && now - Date.parse(last.taken_at) < 15 * 60000) return 0;
  db.prepare('INSERT INTO limits_history (taken_at, plan, primary_remaining, secondary_remaining) VALUES (?, ?, ?, ?)').run(new Date(now).toISOString(), limits.plan ?? null, limits.primary?.remaining ?? null, limits.secondary?.remaining ?? null);
  db.prepare("DELETE FROM limits_history WHERE taken_at < datetime('now', '-30 days')").run();
  return 1;
}

function openCodeSkillSince(db) {
  const count = db.prepare('SELECT COUNT(*) count FROM opencode_skill_events').get().count;
  return Number(count) ? Date.now() - 48 * 60 * 60 * 1000 : 0;
}

function collectOpenCodeIsolated(db, file) {
  return importIsolatedProjection(db, runIsolatedCollector('opencode', file), 'opencode');
}

async function collectOpenCodeIsolatedAsync(db, file) {
  return importIsolatedProjection(db, await runIsolatedCollectorAsync('opencode', file), 'opencode');
}

export async function collectOpenCodeSkillsAsync(db, { file = defaultOpenCodeDatabase() } = {}) {
  if (!fs.existsSync(file)) return { imported: 0, source: file, platform: 'opencode', status: 'not_connected' };
  const signature = openCodeSignature(file), cached = openCodeSkillCaches.get(db);
  if (cached?.file === file && Date.now() - cached.collectedAt < OPEN_CODE_REFRESH_INTERVAL_MS) return { ...cached.result, imported: 0, skipped: true, stale: true };
  if (cached?.file === file && cached.signature === signature) return { ...cached.result, imported: 0, skipped: true };
  try {
    const sinceMs = openCodeSkillSince(db);
    const payload = await runIsolatedCollectorAsync('opencode-skills', file, 120000, [String(sinceMs)]);
    const imported = importOpenCodeSkillEvents(db, payload.skillEvents);
    const result = { imported, source: file, platform: 'opencode', status: 'connected', scannedSince: sinceMs || null };
    openCodeSkillCaches.set(db, { file, signature, result, collectedAt: Date.now() });
    return result;
  } catch (error) {
    return { imported: 0, source: file, platform: 'opencode', status: 'not_connected', error: error.message };
  }
}

export function collectOpenCode(db, { file = defaultOpenCodeDatabase(), isolated = false, skillSinceMs = 0, collectSkills = true } = {}) {
  if (!fs.existsSync(file)) return { imported: 0, source: file, platform: 'opencode', status: 'not_connected' };
  const signature = openCodeSignature(file);
  const cached = openCodeCaches.get(db);
  if (cached?.file === file && Date.now() - cached.collectedAt < OPEN_CODE_REFRESH_INTERVAL_MS) return { ...cached.result, imported: 0, skipped: true, stale: true };
  if (cached?.file === file && cached.signature === signature) return { ...cached.result, imported: 0, skipped: true };
  if (isolated) {
    try {
      const result = collectOpenCodeIsolated(db, file);
      openCodeCaches.set(db, { file, signature, result, collectedAt: Date.now() });
      return result;
    } catch (error) {
      return { imported: 0, source: file, platform: 'opencode', status: 'not_connected', error: error.message };
    }
  }
  let source;
  try {
    source = new DatabaseSync(file, { readOnly: true });
    source.exec('PRAGMA cache_size = -8192; PRAGMA mmap_size = 0;');
    const rows = source.prepare(`
        SELECT s.id, s.parent_id, s.directory, s.agent, s.model, s.cost, s.time_created, s.time_updated,
        s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, p.name project_name
      FROM session s LEFT JOIN project p ON p.id=s.project_id
    `).all();
    const skillEvents = collectSkills ? readOpenCodeSkillEventsFromDatabase(source, skillSinceMs) : [];
    const skills = parseOpenCodeSkills(skillEvents);
    const hasMessage = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='message'").get();
    const messagesBySession = new Map();
    if (hasMessage) {
      const messages = source.prepare(`
        SELECT session_id,
          json_extract(data, '$.modelID') model_id,
          json_extract(data, '$.providerID') provider_id,
          json_extract(data, '$.tokens.input') input_tokens,
          json_extract(data, '$.tokens.cache.read') cached_tokens,
          json_extract(data, '$.tokens.output') output_tokens,
          json_extract(data, '$.tokens.reasoning') reasoning_tokens,
          json_extract(data, '$.tokens.total') total_tokens,
          json_extract(data, '$.time.created') created_at,
          json_extract(data, '$.time.completed') completed_at
        FROM message
        WHERE json_valid(data)
      `);
      for (const message of messages.iterate()) {
        const list = messagesBySession.get(message.session_id) || [];
        list.push(message);
        messagesBySession.set(message.session_id, list);
      }
    }
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
          const perDayModel = new Map();
          let hasMessages = false;
          for (const message of messagesBySession.get(row.id) || []) {
              hasMessages = true;
              const mid = message.model_id || model;
              const prov = message.provider_id || base.provider;
              const ts = message.created_at || message.completed_at || row.time_created;
              const localDay = ts ? new Date(Number(ts)).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) : null;
              const localHour = ts ? parisHour.format(new Date(Number(ts))) : null;
              const key = localDay ? `${mid}__${localDay}__${localHour || ''}` : mid;
               const cur = perDayModel.get(key) || { provider: prov, model: mid, day: localDay, hour: localHour, firstAt: ts, lastAt: ts, input: 0, cached: 0, output: 0, reasoning: 0, total: 0, calls: 0 };
              cur.provider = prov || cur.provider;
              if (ts != null && (cur.firstAt == null || ts < cur.firstAt)) cur.firstAt = ts;
              if (ts != null && (cur.lastAt == null || ts > cur.lastAt)) cur.lastAt = ts;
              cur.input += integer(message.input_tokens);
              cur.cached += integer(message.cached_tokens);
              cur.output += integer(message.output_tokens);
               cur.reasoning += integer(message.reasoning_tokens);
               cur.total += integer(message.total_tokens || (integer(message.input_tokens) + integer(message.cached_tokens) + integer(message.output_tokens) + integer(message.reasoning_tokens)));
               if (message.model_id) cur.calls++;
              perDayModel.set(key, cur);
          }
            if (hasMessages && perDayModel.size) {
              return [...perDayModel.values()].map((agg) => {
                const day = agg.day || iso(row.time_created)?.slice(0,10);
                const id = agg.day ? `opencode:${row.id}:${agg.model}:${agg.day}:${agg.hour || 'unknown'}` : `opencode:${row.id}:${agg.model}`;
                const startedAt = agg.firstAt != null ? iso(agg.firstAt) : (agg.day ? new Date(`${agg.day}T12:00:00+02:00`).toISOString() : base.startedAt);
                const endedAt = agg.lastAt != null ? iso(agg.lastAt) : startedAt;
                return normalizeSession({
                  ...base, provider: agg.provider, id, sourcePath: id,
                  model: agg.model, startedAt, endedAt,
                  durationSeconds: agg.firstAt != null && agg.lastAt != null ? Math.max(0, Math.round((Number(agg.lastAt) - Number(agg.firstAt)) / 1000)) : 0,
                   input: agg.input, cached: agg.cached, output: agg.output, reasoning: agg.reasoning, total: agg.total || agg.input+agg.cached+agg.output+agg.reasoning, modelCalls: agg.calls,
                });
              });
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
    db.exec('BEGIN');
    try {
      // Rebuild the projection so deleted source sessions cannot remain in the dashboard.
      db.prepare("DELETE FROM sessions WHERE platform='opencode'").run();
      const imported = importSessions(db, sessions);
      const skillEventsImported = importOpenCodeSkillEvents(db, skillEvents);
      db.exec('COMMIT');
      const result = { imported, skillEventsImported, sourceSessions: rows.filter((row) => !row.parent_id).length, source: file, platform: 'opencode', status: 'connected', skills };
      openCodeCaches.set(db, { file, signature, result, collectedAt: Date.now() });
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  } catch (error) {
    return { imported: 0, source: file, platform: 'opencode', status: 'not_connected', error: error.message };
  } finally { source?.close(); }
}

export async function collectOpenCodeAsync(db, { file = defaultOpenCodeDatabase() } = {}) {
  if (!fs.existsSync(file)) return { imported: 0, source: file, platform: 'opencode', status: 'not_connected' };
  const signature = openCodeSignature(file);
  const cached = openCodeCaches.get(db);
  if (cached?.file === file && Date.now() - cached.collectedAt < OPEN_CODE_REFRESH_INTERVAL_MS) return { ...cached.result, imported: 0, skipped: true, stale: true };
  if (cached?.file === file && cached.signature === signature) return { ...cached.result, imported: 0, skipped: true };
  try {
    const result = await collectOpenCodeIsolatedAsync(db, file);
    openCodeCaches.set(db, { file, signature, result, collectedAt: Date.now() });
    return result;
  } catch (error) {
    return { imported: 0, source: file, platform: 'opencode', status: 'not_connected', error: error.message };
  }
}
