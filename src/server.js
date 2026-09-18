import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectCodex, collectCodexLimits, collectOpenCode, openDatabase, recordLimitsHistory } from './collector.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = path.join(root, 'public'), dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, 'usage.sqlite'));
const estimatedCost = `(s.input_tokens * COALESCE(p.input_usd_per_million,0) + s.cached_input_tokens * COALESCE(p.cached_input_usd_per_million,0) + s.output_tokens * COALESCE(p.output_usd_per_million,0) + s.reasoning_tokens * COALESCE(p.reasoning_usd_per_million,0)) / 1000000.0`;
const cost = `COALESCE(s.reported_cost_usd, CASE WHEN p.model IS NOT NULL THEN ${estimatedCost} ELSE ${estimatedCost} END)`;
let sourceState = { codex: { status: 'not_connected' }, opencode: { status: 'not_connected' } };

function refresh() { const result = { codex: collectCodex(db), opencode: collectOpenCode(db) }; sourceState = result; return result; }
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
function data(query) {
  const range = calendar(query), ranged = new URLSearchParams(query);
  if (!ranged.get('from')) ranged.set('from', range.start); if (!ranged.get('to')) ranged.set('to', range.end);
  const { where, params } = filters(ranged), base = selectBase(where), price = costs();
  const summary = db.prepare(`SELECT COUNT(*) sessions, COALESCE(SUM(s.input_tokens),0) input, COALESCE(SUM(s.cached_input_tokens),0) cached, COALESCE(SUM(s.output_tokens),0) output, COALESCE(SUM(s.reasoning_tokens),0) reasoning, COALESCE(SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens),0) total, COALESCE(SUM(CASE WHEN s.platform='codex' THEN s.input_tokens END),0) codex_input, COALESCE(SUM(CASE WHEN s.platform='codex' THEN s.cached_input_tokens END),0) codex_cached, COALESCE(SUM(CASE WHEN s.platform='opencode' THEN s.input_tokens END),0) opencode_input, COALESCE(SUM(CASE WHEN s.platform='opencode' THEN s.cached_input_tokens END),0) opencode_cached, COALESCE(SUM(s.cached_input_tokens * (COALESCE(p.input_usd_per_million,0) - COALESCE(p.cached_input_usd_per_million,0)) / 1000000.0),0) cache_saved, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost, SUM(${price.part.input}) input_api_cost, SUM(${price.part.cached}) cached_api_cost, SUM(${price.part.output}) output_api_cost, SUM(${price.part.reasoning}) reasoning_api_cost, SUM(${price.paidPart(price.part.input)}) input_paid_cost, SUM(${price.paidPart(price.part.cached)}) cached_paid_cost, SUM(${price.paidPart(price.part.output)}) output_paid_cost, SUM(${price.paidPart(price.part.reasoning)}) reasoning_paid_cost ${base}`).get(...params);
  const sessions = db.prepare(`SELECT s.*, ${price.api} api_estimated_cost_usd, ${price.paid} out_of_pocket_cost_usd ${base} ORDER BY s.started_at DESC LIMIT 1000`).all(...params);
  for (const row of sessions) row.total_tokens = row.input_tokens + row.cached_input_tokens + row.output_tokens + row.reasoning_tokens; // total = vrai volume, cache inclus
  const dailyRows = db.prepare(`SELECT date(s.started_at,'localtime') day, COALESCE(s.model,'Modèle inconnu') model, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY day, s.model`).all(...params);
  const byDay = new Map(range.days.map((day) => [day, []])); for (const row of dailyRows) byDay.get(row.day)?.push(row);
  const daily = range.days.map((day) => ({ day, series: byDay.get(day) }));
  const models = db.prepare(`SELECT COALESCE(s.model,'Modèle inconnu') label, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY s.model ORDER BY total DESC`).all(...params);
  const platforms = db.prepare(`SELECT s.platform label, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY s.platform ORDER BY total DESC`).all(...params);
  const projects = db.prepare(`SELECT COALESCE(s.project,'Projet inconnu') label, SUM(s.input_tokens+s.cached_input_tokens+s.output_tokens+s.reasoning_tokens) total, SUM(${price.api}) api_cost, SUM(${price.paid}) paid_cost ${base} GROUP BY s.project ORDER BY total DESC`).all(...params);
  const options = db.prepare('SELECT DISTINCT platform, agent, model, project FROM sessions ORDER BY platform, agent, model').all();
  const pricing = db.prepare(`SELECT p.model, MIN(p.platform) platform, MIN(p.input_usd_per_million) input_usd_per_million, MIN(p.cached_input_usd_per_million) cached_input_usd_per_million, MIN(p.output_usd_per_million) output_usd_per_million, MIN(p.reasoning_usd_per_million) reasoning_usd_per_million, MAX(p.updated_at) updated_at FROM model_pricing p WHERE p.pricing_unit='per_1M_tokens' GROUP BY p.model ORDER BY p.model`).all();
  const sourceRows = db.prepare('SELECT platform, COUNT(*) sessions FROM sessions GROUP BY platform').all();
  return { summary, sessions, daily, models, platforms, projects, options, pricing, range, sources: [{ platform: 'codex', status: sourceState.codex.status || 'connected', sessions: sourceRows.find((row) => row.platform === 'codex')?.sessions || 0 }, { platform: 'opencode', status: sourceState.opencode.status, sessions: sourceRows.find((row) => row.platform === 'opencode')?.sessions || 0 }] };
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
try { localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10000 }).toString().trim() || null; } catch { /* pas un clone git, maj auto désactivée */ }
function pullUpdate() {
  try {
    const output = execFileSync('git', ['pull', '--ff-only'], { cwd: root, timeout: 120000 }).toString();
    try { localCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 10000 }).toString().trim() || null; } catch {}
    return { updated: true, output: output.trim().slice(-500) };
  } catch (error) { throw new Error((error.stderr?.toString().trim() || error.message).slice(-300) || 'git pull impossible'); }
}
function sendJson(res, payload, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); }
function sendFile(res, file) { if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; } const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html'; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); fs.createReadStream(file).pipe(res); }
function readBody(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', (chunk) => raw += chunk); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('JSON invalide')); } }); req.on('error', reject); }); }

refresh();
const desiredPort = process.env.PORT ? Number(process.env.PORT) : 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'POST' && url.pathname === '/api/refresh') return sendJson(res, refresh());
    if (req.method === 'POST' && url.pathname === '/api/pricing') return sendJson(res, savePricing(await readBody(req)));
    if (url.pathname === '/api/data') return sendJson(res, data(url.searchParams));
    if (url.pathname === '/api/limits') { const limits = await collectCodexLimits(); recordLimitsHistory(db, limits); return sendJson(res, limits); }
    if (url.pathname === '/api/limits/history') {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const points = db.prepare("SELECT taken_at t, primary_remaining p, secondary_remaining s FROM limits_history WHERE taken_at >= datetime('now', ?) ORDER BY taken_at").all(`-${days} days`);
      return sendJson(res, { points });
    }
    if (url.pathname === '/api/version') return sendJson(res, { stamp: Math.max(...['index.html', 'app.js', 'style.css'].map((f) => fs.statSync(path.join(publicDir, f)).mtimeMs)), commit: localCommit });
    if (req.method === 'POST' && url.pathname === '/api/update') return sendJson(res, pullUpdate());
    if (url.pathname === '/') return sendFile(res, path.join(publicDir, 'index.html'));
    if (url.pathname === '/app.js') return sendFile(res, path.join(publicDir, 'app.js'));
    if (url.pathname === '/style.css') return sendFile(res, path.join(publicDir, 'style.css'));
    res.writeHead(404); res.end('Not found');
  } catch (error) { sendJson(res, { error: error.message }, 400); }
});
server.listen(desiredPort, '127.0.0.1', async () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  console.log(`AI Usage Monitor: ${url}`);
  if (process.argv.includes('--open')) {
    try {
      const { exec } = await import('node:child_process');
      const command = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(command);
    } catch {}
  }
});
