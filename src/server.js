import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectCodexLimits, collectCodexAsync, collectOpenCodeAsync, openDatabase, recordLimitsHistory } from './collector.js';
import { defaultDataDirectory, mergeLegacyData } from './storage.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(root, 'public'), dataDir = defaultDataDirectory(root);
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, 'usage.sqlite'));
const legacyDatabase = path.join(process.env.AI_USAGE_LEGACY_DATA_DIR || path.join(root, 'data'), 'usage.sqlite');
if (path.resolve(dataDir, 'usage.sqlite') !== path.resolve(legacyDatabase)) mergeLegacyData(db, legacyDatabase, process.env.AI_USAGE_MIGRATION_KEY);
const estimatedCost = `(s.input_tokens * COALESCE(p.input_usd_per_million,0) + s.cached_input_tokens * COALESCE(p.cached_input_usd_per_million,0) + s.output_tokens * COALESCE(p.output_usd_per_million,0) + s.reasoning_tokens * COALESCE(p.reasoning_usd_per_million,0)) / 1000000.0`;
const cost = `COALESCE(s.reported_cost_usd, CASE WHEN p.model IS NOT NULL THEN ${estimatedCost} ELSE ${estimatedCost} END)`;
const ACTIVITY_VERSION = 3;
let sourceState = { codex: { status: 'not_connected' }, opencode: { status: 'not_connected' } };
let adtentionCache = { at: 0, value: null };
let initialRefreshTimer = null;
let refreshPromise = null;
let refreshState = { running: false, result: null, error: null, startedAt: null, finishedAt: null };
const adtentionApi = (process.env.ADTENTION_API || 'https://api.adtention.ai').replace(/\/+$/, '');

function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshState = { running: true, result: null, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  refreshPromise = (async () => {
    const opencode = await collectOpenCodeAsync(db);
    const codex = await collectCodexAsync(db);
    const result = { codex, opencode };
    sourceState = result;
    if (typeof global.gc === 'function') global.gc();
    return result;
  })().then((result) => {
    refreshState = { ...refreshState, running: false, result, finishedAt: new Date().toISOString() };
    return result;
  }).catch((error) => {
    refreshState = { ...refreshState, running: false, error: error.message, finishedAt: new Date().toISOString() };
    throw error;
  }).finally(() => { refreshPromise = null; });
  return refreshPromise;
}
async function adtentionBalance() {
  if (Date.now() - adtentionCache.at < 15000) return adtentionCache.value;
  const kvFile = path.join(os.homedir(), '.local', 'state', 'opencode', 'kv.json');
  let kv;
  try { kv = JSON.parse(fs.readFileSync(kvFile, 'utf8')); } catch { adtentionCache = { at: Date.now(), value: null }; return null; }
  const publisherId = kv['adtention:identity']?.publisher_id;
  if (!publisherId) { adtentionCache = { at: Date.now(), value: null }; return null; }
  const fallback = Number(kv['adtention:balance']);
  try {
    const response = await fetch(`${adtentionApi}/v1/balance?publisher_id=${encodeURIComponent(publisherId)}`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    if (!response.ok || typeof body.balance_usd !== 'number') throw new Error('ADtention balance unavailable');
    adtentionCache = { at: Date.now(), value: { available: true, balanceUsd: body.balance_usd, billableImpressions: body.billable_impressions ?? null } };
  } catch {
    adtentionCache = { at: Date.now(), value: Number.isFinite(fallback) ? { available: true, balanceUsd: fallback, billableImpressions: null, stale: true } : null };
  }
  return adtentionCache.value;
}
function subscriptionEnabled() { return db.prepare("SELECT value FROM app_settings WHERE key='openai_subscription'").get()?.value === 'true'; }
function costs() {
  const api = estimatedCost;
  const openAiModel = `(LOWER(COALESCE(s.provider,''))='openai' OR LOWER(COALESCE(s.model,'')) GLOB 'gpt-*' OR LOWER(COALESCE(s.model,'')) LIKE '%/gpt-%' OR LOWER(COALESCE(s.model,'')) GLOB 'o[134]-*' OR LOWER(COALESCE(s.model,'')) GLOB 'codex-*' OR LOWER(COALESCE(s.model,'')) LIKE 'chatgpt-%')`;
  const covered = `(s.platform='codex' OR (s.platform='opencode' AND ${openAiModel}))`;
  const paid = subscriptionEnabled() ? `CASE WHEN ${covered} THEN 0 ELSE ${api} END` : api;
  const part = {
    input: `(s.input_tokens * COALESCE(p.input_usd_per_million,0)) / 1000000.0`,
    cached: `(s.cached_input_tokens * COALESCE(p.cached_input_usd_per_million,0)) / 1000000.0`,
    output: `(s.output_tokens * COALESCE(p.output_usd_per_million,0)) / 1000000.0`,
    reasoning: `(s.reasoning_tokens * COALESCE(p.reasoning_usd_per_million,0)) / 1000000.0`,
  };
  const paidPart = (expr) => subscriptionEnabled() ? `CASE WHEN ${covered} THEN 0 ELSE ${expr} END` : expr;
  return { api, paid, part, paidPart };
}
const parisDateStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function filters(query) {
  const clauses = [], params = [];
  for (const [key, column] of [['platform', 's.platform'], ['agent', 's.agent'], ['model', 's.model']]) {
    if (query.get(key)) { clauses.push(`${column} = ?`); params.push(query.get(key)); }
  }
  if (query.get('project')) { clauses.push('s.project LIKE ?'); params.push(`%${query.get('project')}%`); }
  if (query.get('from')) { clauses.push("date(s.started_at,'localtime') >= date(?)"); params.push(query.get('from')); }
  if (query.get('to')) { clauses.push("date(s.started_at,'localtime') <= date(?)"); params.push(query.get('to')); }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
function selectBase(where) { return `FROM sessions s LEFT JOIN model_pricing p ON p.platform=s.platform AND p.model=COALESCE(s.model, '') ${where}`; }
function calendar(query) {
  const end = query.get('to') || parisDateStr(new Date());
  const period = Math.max(1, Number(query.get('period')) || 14);
  // period in Paris local days
  const endDate = new Date(`${end}T12:00:00`);
  const startDate = query.get('from') ? new Date(`${query.get('from')}T12:00:00`) : new Date(endDate);
  if (!query.get('from')) startDate.setDate(startDate.getDate() - period + 1);
  const start = parisDateStr(startDate), finish = parisDateStr(endDate);
  const days = [];
  for (let d = new Date(`${start}T12:00:00`); parisDateStr(d) <= finish; d.setDate(d.getDate() + 1)) days.push(parisDateStr(d));
  return { start, end, days };
}
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function activityCalendar(query) {
  const today = parisDateStr(new Date());
  const todayDate = new Date(`${today}T12:00:00Z`);
  const mondayOffset = (todayDate.getUTCDay() + 6) % 7;
  const currentStart = shiftDate(today, -mondayOffset);
  const requestedStart = query.get('activityFrom');
  const requestedEnd = query.get('activityTo');
  const start = isoDate.test(requestedStart || '') ? requestedStart : currentStart;
  const end = isoDate.test(requestedEnd || '') ? requestedEnd : shiftDate(start, 6);
  return { start, end };
}
const openCodeSessionId = "CASE WHEN instr(substr(s.id, 10), ':') > 0 THEN substr(substr(s.id, 10), 1, instr(substr(s.id, 10), ':') - 1) ELSE substr(s.id, 10) END";
const hiddenOpenCodeAgents = "LOWER(COALESCE(s.agent, '')) NOT IN ('plan', 'build', 'general')";
function dailyAgents(base, params, days) {
  const scopedBase = base.includes(' WHERE ') ? `${base} AND s.platform='opencode'` : `${base} WHERE s.platform='opencode'`;
  const rows = db.prepare(`SELECT date(s.started_at,'localtime') day, s.agent, COUNT(DISTINCT ${openCodeSessionId}) sessions ${scopedBase} AND ${hiddenOpenCodeAgents} GROUP BY day, s.agent ORDER BY day DESC, sessions DESC, s.agent`).all(...params);
  const grouped = new Map(days.map((day) => [day, []]));
  for (const row of rows) grouped.get(row.day)?.push({ agent: row.agent || 'OpenCode', sessions: Number(row.sessions) || 0 });
  return days.map((day) => ({ day, agents: grouped.get(day) }));
}
const activityClock = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
const activityDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function activityHeatmap(base, params, price) {
  const cells = activityDays.flatMap((day, dayIndex) => Array.from({ length: 24 }, (_, hour) => ({ day, dayIndex, hour, sessions: 0, total: 0, apiCost: 0, paidCost: 0 })));
  const rows = db.prepare(`SELECT s.started_at activity_at, s.input_tokens, s.cached_input_tokens, s.output_tokens, s.reasoning_tokens, ${price.api} api_cost, ${price.paid} paid_cost ${base}`).all(...params);
  for (const row of rows) {
    const date = new Date(row.activity_at);
    if (Number.isNaN(date.getTime())) continue;
    const parts = Object.fromEntries(activityClock.formatToParts(date).map(({ type, value }) => [type, value]));
    const dayIndex = (activityDays.indexOf(parts.weekday) + 7) % 7, hour = Number(parts.hour);
    const cell = cells[dayIndex * 24 + hour];
    cell.sessions++;
    cell.total += Number(row.input_tokens || 0) + Number(row.cached_input_tokens || 0) + Number(row.output_tokens || 0) + Number(row.reasoning_tokens || 0);
    cell.apiCost += Number(row.api_cost) || 0;
    cell.paidCost += Number(row.paid_cost) || 0;
  }
  return cells;
}
function data(query) {
  const range = calendar(query), activityRange = activityCalendar(query), ranged = new URLSearchParams(query);
  if (!ranged.get('from')) ranged.set('from', range.start); if (!ranged.get('to')) ranged.set('to', range.end);
  const { where, params } = filters(ranged), base = selectBase(where), price = costs();
  const activityQuery = new URLSearchParams(query);
  activityQuery.delete('from'); activityQuery.delete('to');
  activityQuery.set('from', activityRange.start); activityQuery.set('to', activityRange.end);
  const activityFilters = filters(activityQuery), activityBase = selectBase(activityFilters.where);
  const summary = db.prepare(`SELECT COUNT(*) sessions, COALESCE(SUM(s.input_tokens),0) input, COALESCE(SUM(s.cached_input_tokens),0) cached, COALESCE(SUM(s.output_tokens),0) output, COALESCE(SUM(s.reasoning_tokens),0) reasoning, COALESCE(SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens),0) total, COALESCE(SUM(CASE WHEN s.platform='codex' THEN s.input_tokens END),0) codex_input, COALESCE(SUM(CASE WHEN s.platform='codex' THEN s.cached_input_tokens END),0) codex_cached, COALESCE(SUM(CASE WHEN s.platform='opencode' THEN s.input_tokens END),0) opencode_input, COALESCE(SUM(CASE WHEN s.platform='opencode' THEN s.cached_input_tokens END),0) opencode_cached, COALESCE(SUM(s.cached_input_tokens * (COALESCE(p.input_usd_per_million,0) - COALESCE(p.cached_input_usd_per_million,0)) / 1000000.0),0) cache_saved, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost, SUM(${price.part.input}) input_api_cost, SUM(${price.part.cached}) cached_api_cost, SUM(${price.part.output}) output_api_cost, SUM(${price.part.reasoning}) reasoning_api_cost, SUM(${price.paidPart(price.part.input)}) input_paid_cost, SUM(${price.paidPart(price.part.cached)}) cached_paid_cost, SUM(${price.paidPart(price.part.output)}) output_paid_cost, SUM(${price.paidPart(price.part.reasoning)}) reasoning_paid_cost ${base}`).get(...params);
  const dailyRows = db.prepare(`SELECT date(s.started_at,'localtime') day, COALESCE(s.model,'Modèle inconnu') model, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY day, s.model`).all(...params);
  const byDay = new Map(range.days.map((day) => [day, []])); for (const row of dailyRows) byDay.get(row.day)?.push(row);
  const daily = range.days.map((day) => ({ day, series: byDay.get(day) }));
  const agentDaily = dailyAgents(base, params, range.days);
  const activity = activityHeatmap(activityBase, activityFilters.params, price);
  const models = db.prepare(`SELECT COALESCE(s.model,'Modèle inconnu') label, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY s.model ORDER BY total DESC`).all(...params);
  const platforms = db.prepare(`SELECT s.platform label, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY s.platform ORDER BY total DESC`).all(...params);
  const projects = db.prepare(`SELECT COALESCE(s.project,'Projet inconnu') label, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY s.project ORDER BY total DESC`).all(...params);
  const options = db.prepare('SELECT DISTINCT platform, agent, model, project FROM sessions ORDER BY platform, agent, model').all();
  const pricing = db.prepare(`SELECT p.model, MIN(p.platform) platform, MIN(p.input_usd_per_million) input_usd_per_million, MIN(p.cached_input_usd_per_million) cached_input_usd_per_million, MIN(p.output_usd_per_million) output_usd_per_million, MIN(p.reasoning_usd_per_million) reasoning_usd_per_million, MAX(p.updated_at) updated_at FROM model_pricing p WHERE p.pricing_unit='per_1M_tokens' GROUP BY p.model ORDER BY p.model`).all();
  const sourceRows = db.prepare('SELECT platform, COUNT(*) sessions FROM sessions GROUP BY platform').all();
  const sources = [{ platform: 'codex', status: sourceState.codex.status || 'connected', sessions: sourceState.codex.sourceSessions ?? (sourceRows.find((row) => row.platform === 'codex')?.sessions || 0) }, { platform: 'opencode', status: sourceState.opencode.status, sessions: sourceState.opencode.sourceSessions ?? (sourceRows.find((row) => row.platform === 'opencode')?.sessions || 0) }];
  return { activityVersion: ACTIVITY_VERSION, summary, daily, agentDaily, activity, activityRange, models, platforms, projects, options, pricing, range, sources };
}
function savePricing(body) {
  if (!Array.isArray(body.pricing)) throw new Error('Prix invalides');
  const upsert = db.prepare(`INSERT INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, provider, pricing_unit, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, model) DO UPDATE SET input_usd_per_million=excluded.input_usd_per_million, cached_input_usd_per_million=excluded.cached_input_usd_per_million, output_usd_per_million=excluded.output_usd_per_million, reasoning_usd_per_million=excluded.reasoning_usd_per_million, updated_at=excluded.updated_at`);
  for (const row of body.pricing) {
    if (!row.platform || !row.model) throw new Error('Plateforme ou modèle manquant');
    const rates = ['input', 'cached', 'output', 'reasoning'].map((name) => Number(row[name]));
    if (rates.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Prix non valide');
    const now = new Date().toISOString();
    for (const platform of ['codex','opencode']) {
      const existing = db.prepare('SELECT provider, pricing_unit FROM model_pricing WHERE platform=? AND model=?').get(platform, row.model);
      const provider = existing?.provider || 'openai';
      const unit = existing?.pricing_unit || 'per_1M_tokens';
      upsert.run(platform, row.model, ...rates, provider, unit, now);
    }
  }
  return { saved: body.pricing.length };
}
let localCommit = null;
const gitRepository = fs.existsSync(path.join(root, '.git'));
if (gitRepository) {
  try { localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { /* pas un clone git, maj auto désactivée */ }
}
function pullUpdate() {
  if (!gitRepository) throw new Error('Mise à jour intégrée indisponible dans cette installation');
  try {
    const output = execFileSync('git', ['pull', '--ff-only'], { cwd: root, timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    try { localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch {}
    return { updated: true, output: output.trim().slice(-500) };
  } catch (error) { throw new Error((error.stderr?.toString().trim() || error.message).slice(-300) || 'git pull impossible'); }
}
function sendJson(res, payload, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
function sendFile(res, file) { if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; } const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res); }
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', (chunk) => raw += chunk); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON invalide')); } }); req.on('error', reject); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      refresh().catch(() => {});
      return sendJson(res, { started: true, running: true }, 202);
    }
    if (url.pathname === '/api/refresh/status') return sendJson(res, refreshState);
    if (url.pathname === '/api/adtention/balance') return sendJson(res, await adtentionBalance());
    if (req.method === 'POST' && url.pathname === '/api/pricing') return sendJson(res, savePricing(await readBody(req)));
    if (url.pathname === '/api/data') return sendJson(res, data(url.searchParams));
    if (url.pathname === '/api/limits') {
      const limits = await collectCodexLimits(url.searchParams.get('force') === '1' ? { cacheMs: 0 } : {});
      recordLimitsHistory(db, limits);
      return sendJson(res, limits);
    }
    if (url.pathname === '/api/limits/history') {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const points = db.prepare("SELECT taken_at t, primary_remaining p, secondary_remaining s FROM limits_history WHERE taken_at >= datetime('now', ?) ORDER BY taken_at").all(`-${days} days`);
      return sendJson(res, { points });
    }
    if (url.pathname === '/api/version') return sendJson(res, { stamp: Math.max(...['index.html', 'app.js', 'style.css'].map((f) => fs.statSync(path.join(publicDir, f)).mtimeMs)), commit: localCommit, activityVersion: ACTIVITY_VERSION });
    if (req.method === 'POST' && url.pathname === '/api/update') return sendJson(res, pullUpdate());
    if (url.pathname === '/') return sendFile(res, path.join(publicDir, 'index.html'));
    if (url.pathname === '/app.js') return sendFile(res, path.join(publicDir, 'app.js'));
    if (url.pathname === '/style.css') return sendFile(res, path.join(publicDir, 'style.css'));
    res.writeHead(404); res.end('Not found');
  } catch (error) { sendJson(res, { error: error.message }, 400); }
});
export function startServer({ open = false, port = process.env.PORT ? Number(process.env.PORT) : 0 } = {}) {
  if (server.listening) {
    const address = server.address();
    return Promise.resolve({ server, port: address.port, url: `http://127.0.0.1:${address.port}` });
  }
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = async () => {
      server.off('error', onError);
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}`;
      console.log(`AI Usage Monitor: ${url}`);
      initialRefreshTimer = setTimeout(() => {
        initialRefreshTimer = null;
        refresh().catch((error) => console.error(`Initial refresh failed: ${error.message}`));
      }, 1000);
      if (open) {
        try {
          const { exec } = await import('node:child_process');
          const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
          exec(command);
        } catch {}
      }
      resolve({ server, port: address.port, url });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export function stopServer() {
  if (initialRefreshTimer) { clearTimeout(initialRefreshTimer); initialRefreshTimer = null; }
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) startServer({ open: process.argv.includes('--open') }).catch((error) => { console.error(error); process.exitCode = 1; });
