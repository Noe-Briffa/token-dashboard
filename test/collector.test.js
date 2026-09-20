import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectCodex, collectCodexLimits, collectOpenCode, importSessions, normalizeLimits, normalizeSession, openDatabase, parseCodexSession, recordLimitsHistory } from '../src/collector.js';
import { mergeLegacyData } from '../src/storage.js';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-'));

test('migrates existing sessions to codex platform without losing data', () => {
  const directory = temp(), file = path.join(directory, 'usage.sqlite');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, agent TEXT NOT NULL, source_path TEXT NOT NULL UNIQUE, project TEXT, model TEXT, started_at TEXT, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL, updated_at TEXT NOT NULL); INSERT INTO sessions (id,agent,source_path,updated_at) VALUES ('old','Codex CLI','old.jsonl','2026-01-01')"); old.close();
  const db = openDatabase(file), row = db.prepare('SELECT id, platform, agent FROM sessions').get();
  assert.equal(row.id, 'old'); assert.equal(row.platform, 'codex'); assert.equal(row.agent, 'Codex CLI');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_pricing'").get().name, 'model_pricing');
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('merges legacy pricing and limits history without overwriting newer values', () => {
  const directory = temp(), legacyFile = path.join(directory, 'legacy.sqlite'), targetFile = path.join(directory, 'target.sqlite');
  const legacy = openDatabase(legacyFile);
  legacy.prepare("INSERT INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, cache_writes_usd_per_million, provider, pricing_unit, per_minute_usd, updated_at) VALUES ('codex', 'legacy-model', 1, 2, 3, 4, 5, 'openai', 'per_1M_tokens', 6, '2026-09-20T12:00:00.000Z')").run();
  legacy.prepare("INSERT INTO limits_history (taken_at, plan, primary_remaining, secondary_remaining) VALUES ('2026-09-20T12:00:00.000Z', 'plus', 80, 70)").run();
  legacy.prepare("INSERT INTO app_settings (key, value) VALUES ('legacy_setting', 'enabled')").run();
  legacy.prepare("UPDATE app_settings SET value='false' WHERE key='openai_subscription'").run();
  importSessions(legacy, [{ platform: 'codex', agent: 'Codex CLI', id: 'legacy-session', sourcePath: 'legacy-session.jsonl', total: 123 }]);
  legacy.close();
  const target = openDatabase(targetFile);
  assert.equal(mergeLegacyData(target, legacyFile), true);
  const pricing = target.prepare("SELECT input_usd_per_million, output_usd_per_million, cache_writes_usd_per_million, per_minute_usd FROM model_pricing WHERE platform='codex' AND model='legacy-model'").get();
  assert.deepEqual({ ...pricing }, { input_usd_per_million: 1, output_usd_per_million: 3, cache_writes_usd_per_million: 5, per_minute_usd: 6 });
  assert.equal(target.prepare("SELECT COUNT(*) n FROM limits_history WHERE taken_at='2026-09-20T12:00:00.000Z'").get().n, 1);
  assert.equal(target.prepare("SELECT value FROM app_settings WHERE key='legacy_setting'").get().value, 'enabled');
  assert.equal(target.prepare("SELECT value FROM app_settings WHERE key='openai_subscription'").get().value, 'false');
  assert.equal(target.prepare("SELECT total_tokens FROM sessions WHERE id='legacy-session'").get().total_tokens, 123);
  assert.ok(target.prepare("SELECT value FROM app_settings WHERE key='migration.electron.v1'").get().value);
  assert.equal(mergeLegacyData(target, legacyFile), false);
  assert.equal(mergeLegacyData(target, legacyFile, 'migration.tauri.v1'), true);
  assert.ok(target.prepare("SELECT value FROM app_settings WHERE key='migration.tauri.v1'").get().value);
  assert.equal(mergeLegacyData(target, legacyFile, 'migration.tauri.v1'), false);
  target.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('imports Codex usage with platform and normalizes future collector contract', () => {
  const directory = temp(), sessions = path.join(directory, 'sessions', '2026', '08', '31'); fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-test.jsonl');
  const usage = (total, cached = 0) => ({ timestamp: '2026-08-31T10:02:00Z', type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: total, cached_input_tokens: cached, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total } } } });
  const rows = [
    { timestamp: '2026-08-31T10:00:00Z', type: 'session_meta', payload: { session_id: 'abc', timestamp: '2026-08-31T10:00:00Z', cwd: 'C:/work', originator: 'Codex Desktop' } },
    { timestamp: '2026-08-31T10:01:00Z', type: 'turn_context', payload: { model: 'gpt-test' } },
    usage(0),
    { timestamp: '2026-08-31T10:02:00Z', type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 10, total_tokens: 130 } } } }
  ]; fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const db = openDatabase(path.join(directory, 'usage.sqlite'));
  const first = collectCodex(db, { root: path.join(directory, 'sessions') });
  const second = collectCodex(db, { root: path.join(directory, 'sessions') });
  assert.equal(first.imported, 1); assert.equal(second.skipped, true); assert.equal(second.imported, 0);
  const codex = db.prepare('SELECT platform, agent, model, total_tokens FROM sessions WHERE id=?').get('abc');
  assert.equal(codex.platform, 'codex'); assert.equal(codex.agent, 'Codex Desktop'); assert.equal(codex.model, 'gpt-test'); assert.equal(codex.total_tokens, 130);
  const future = normalizeSession({ platform: 'opencode', agent: 'OpenCode', id: 'open-1', sourcePath: 'db', model: 'x', input: 3, cached: 1, output: 2, reasoning: 0, total: 5 });
  importSessions(db, [future]);
  const opencode = db.prepare('SELECT platform, agent, total_tokens FROM sessions WHERE id=?').get('open-1');
  assert.equal(opencode.platform, 'opencode'); assert.equal(opencode.agent, 'OpenCode'); assert.equal(opencode.total_tokens, 5);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('preserves missing reported cost while retaining a real free cost', () => {
  assert.equal(normalizeSession({ platform: 'codex', agent: 'Codex CLI', id: 'unknown', sourcePath: 'x', reportedCost: null }).reportedCost, null);
  assert.equal(normalizeSession({ platform: 'opencode', agent: 'OpenCode', id: 'free', sourcePath: 'y', reportedCost: 0 }).reportedCost, 0);
});

test('stored price changes computed cost without changing session data', () => {
  const directory = temp(), db = openDatabase(path.join(directory, 'usage.sqlite'));
  importSessions(db, [{ platform: 'codex', agent: 'Codex CLI', id: 'cost-1', sourcePath: 'session', model: 'gpt-test', input: 100, cached: 50, output: 20, reasoning: 10, total: 130 }]);
  const query = `SELECT CASE WHEN p.model IS NOT NULL THEN (s.input_tokens*p.input_usd_per_million+s.cached_input_tokens*p.cached_input_usd_per_million+s.output_tokens*p.output_usd_per_million+s.reasoning_tokens*p.reasoning_usd_per_million)/1000000.0 END cost FROM sessions s LEFT JOIN model_pricing p ON p.platform=s.platform AND p.model=s.model WHERE s.id='cost-1'`;
  assert.equal(db.prepare(query).get().cost, 0); // auto-ligne prix à 0 jusqu'à saisie
  const price = db.prepare("INSERT INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(platform, model) DO UPDATE SET input_usd_per_million=excluded.input_usd_per_million, cached_input_usd_per_million=excluded.cached_input_usd_per_million, output_usd_per_million=excluded.output_usd_per_million, reasoning_usd_per_million=excluded.reasoning_usd_per_million, updated_at=excluded.updated_at");
  price.run('codex', 'gpt-test', 1, 0.5, 2, 2, 'now'); assert.equal(db.prepare(query).get().cost, 0.000185);
  db.prepare('UPDATE model_pricing SET output_usd_per_million=4').run(); assert.equal(db.prepare(query).get().cost, 0.000225);
  assert.equal(db.prepare("SELECT total_tokens FROM sessions WHERE id='cost-1'").get().total_tokens, 130);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('imports OpenCode model IDs, reported cost and cache reads', () => {
  const directory = temp(), sourceFile = path.join(directory, 'opencode.db'), target = openDatabase(path.join(directory, 'usage.sqlite'));
  const source = new DatabaseSync(sourceFile);
  source.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, agent TEXT, model TEXT, cost REAL, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER); INSERT INTO project VALUES ('p1','Demo'); INSERT INTO session VALUES ('s1','p1',NULL,'C:/demo','build','{"id":"provider/model","providerID":"openai","variant":"fast"}',0.42,1000,61000,100,25,15,75);`); source.close();
  const result = collectOpenCode(target, { file: sourceFile });
  assert.equal(result.status, 'connected'); assert.equal(result.imported, 1);
  assert.equal(collectOpenCode(target, { file: sourceFile }).skipped, true);
  const row = target.prepare('SELECT platform, provider, model, project, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, reported_cost_usd FROM sessions WHERE id=?').get('opencode:s1');
  assert.equal(row.platform, 'opencode'); assert.equal(row.provider, 'openai'); assert.equal(row.model, 'provider/model'); assert.equal(row.project, 'Demo'); assert.equal(row.input_tokens, 100); assert.equal(row.cached_input_tokens, 75); assert.equal(row.total_tokens, 215); assert.equal(row.reported_cost_usd, 0.42);
  target.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('rebuilds OpenCode projection and reports source sessions separately from segments', () => {
  const directory = temp(), sourceFile = path.join(directory, 'opencode.db'), target = openDatabase(path.join(directory, 'usage.sqlite'));
  const source = new DatabaseSync(sourceFile);
  source.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, agent TEXT, model TEXT, cost REAL, time_created INTEGER, time_updated INTEGER, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER); CREATE TABLE message (session_id TEXT, data TEXT); INSERT INTO session VALUES ('live','p1',NULL,'C:/demo','build','{"id":"gpt-5.6-luna","providerID":"openai"}',0,0,0,0,0,0,0); INSERT INTO session VALUES ('child','p1','live','C:/demo','explore','{"id":"gpt-5.6-luna","providerID":"openai"}',0,0,0,0,0,0,0);`);
  const message = (modelID, created, total) => JSON.stringify({ modelID, time: { created }, tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0 } } });
  source.exec("INSERT INTO project VALUES ('p1','Demo')");
  source.prepare('INSERT INTO message (session_id, data) VALUES (?, ?)').run('live', message('gpt-5.6-luna', Date.parse('2026-09-17T10:00:00Z'), 100));
  source.prepare('INSERT INTO message (session_id, data) VALUES (?, ?)').run('live', message('gpt-5.6-sol', Date.parse('2026-09-18T10:00:00Z'), 200));
  source.close();
  importSessions(target, [{ platform: 'opencode', agent: 'OpenCode', id: 'opencode:deleted', sourcePath: 'deleted', input: 999, total: 999 }]);
  const result = collectOpenCode(target, { file: sourceFile });
  assert.equal(result.sourceSessions, 1);
  assert.equal(result.imported, 3);
  assert.equal(target.prepare("SELECT COUNT(*) n FROM sessions WHERE platform='opencode'").get().n, 3);
  assert.equal(target.prepare("SELECT COUNT(*) n FROM sessions WHERE id='opencode:deleted'").get().n, 0);
  assert.deepEqual(target.prepare("SELECT model, total_tokens FROM sessions WHERE platform='opencode' ORDER BY model, total_tokens").all().map((row) => ({ ...row })), [
    { model: 'gpt-5.6-luna', total_tokens: 0 },
    { model: 'gpt-5.6-luna', total_tokens: 100 },
    { model: 'gpt-5.6-sol', total_tokens: 200 },
  ]);
  target.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('reports unavailable OpenCode database without interrupting imports', () => {
  const directory = temp(), db = openDatabase(path.join(directory, 'usage.sqlite'));
  const result = collectOpenCode(db, { file: path.join(directory, 'missing.db') });
  assert.equal(result.status, 'not_connected'); assert.equal(result.imported, 0);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('normalizes Codex rate limits to remaining percent with reset time', async () => {
  const payload = { plan_type: 'plus', rate_limit: { primary_window: { used_percent: 25, reset_at: 1779459394 }, secondary_window: { used_percent: 18, reset_at: 1779826837 } } };
  assert.deepEqual(normalizeLimits(payload), { status: 'connected', plan: 'plus', primary: { remaining: 75, resetsAt: '2026-05-22T14:16:34.000Z' }, secondary: { remaining: 82, resetsAt: '2026-05-26T20:20:37.000Z' } });
  assert.equal(normalizeLimits({}).status, 'empty');
  assert.equal(normalizeLimits({ rate_limit: { primary_window: null, secondary_window: null } }).status, 'empty');
  const directory = temp(), auth = path.join(directory, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x', account_id: 'y' } }));
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push([url, options.headers]); return { status: 200, ok: true, json: async () => payload }; };
  const limits = await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl });
  assert.equal(limits.status, 'connected'); assert.equal(limits.primary.remaining, 75);
  assert.equal(seen[0][0], 'https://chatgpt.com/backend-api/wham/usage');
  const expired = await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl: async () => ({ status: 401, ok: false }) });
  assert.equal(expired.status, 'auth_expired');
  assert.equal(expired.primary.remaining, 75); // dernier succès conservé
  assert.ok(typeof expired.fetchedAt === 'string');
  assert.equal((await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl: async () => ({ status: 429, ok: false }) })).status, 'rate_limited');
  assert.equal((await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl: async () => ({ status: 500, ok: false }) })).status, 'service');
  assert.equal((await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl: async () => { throw new Error('down'); } })).status, 'network');
  assert.equal((await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({}) }) })).status, 'empty');
  const missing = await collectCodexLimits({ authFile: path.join(directory, 'nope.json'), cacheMs: 0, fetchImpl });
  assert.equal(missing.status, 'not_connected');
  const timeout = new Error('slow'); timeout.name = 'TimeoutError';
  assert.equal((await collectCodexLimits({ authFile: auth, cacheMs: 0, fetchImpl: async () => { throw timeout; } })).reason, 'timeout');
  const failureAt = Date.now() + 1000;
  let attempts = 0;
  await collectCodexLimits({ authFile: auth, cacheMs: 0, now: failureAt, fetchImpl: async () => { attempts++; throw new Error('down'); } });
  const recovered = await collectCodexLimits({ authFile: auth, cacheMs: 300000, now: failureAt + 30001, fetchImpl: async () => { attempts++; return { status: 200, ok: true, json: async () => payload }; } });
  assert.equal(recovered.status, 'connected'); assert.equal(attempts, 2);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('records limits history throttled with 30-day purge', () => {
  const directory = temp(), db = openDatabase(path.join(directory, 'usage.sqlite'));
  const good = { status: 'connected', plan: 'plus', primary: { remaining: 80 }, secondary: { remaining: 60 } };
  const now = Date.now();
  assert.equal(recordLimitsHistory(db, { status: 'network' }, now), 0);
  assert.equal(recordLimitsHistory(db, good, now - 32 * 60000), 1);
  assert.equal(recordLimitsHistory(db, good, now - 31 * 60000), 0); // throttle 15 min
  assert.equal(recordLimitsHistory(db, good, now - 16 * 60000), 1);
  db.prepare("INSERT INTO limits_history (taken_at, plan, primary_remaining, secondary_remaining) VALUES (datetime('now', '-31 days'), 'plus', 50, 50)").run();
  assert.equal(recordLimitsHistory(db, good, now), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM limits_history WHERE taken_at < datetime('now', '-30 days')").get().n, 0);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('counts per-file deltas for resumed Codex sessions sharing cumulative counters', () => {
  const directory = temp(), root = path.join(directory, 'sessions'); fs.mkdirSync(root, { recursive: true });
  const meta = { session_id: 'dup-1', timestamp: '2026-09-17T10:00:00Z', cwd: 'C:/x', originator: 'Codex CLI' };
  const turn = { timestamp: '2026-09-17T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-test' } };
  const usage = (total, at) => ({ timestamp: at, type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total } } } });
  const head = [{ timestamp: '2026-09-17T10:00:00Z', type: 'session_meta', payload: meta }, turn];
  fs.writeFileSync(path.join(root, 'rollout-a.jsonl'), [...head, usage(0, '2026-09-17T10:01:00Z'), usage(100, '2026-09-17T11:00:00Z')].map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(root, 'rollout-a_ffff.jsonl'), [...head, usage(100, '2026-09-17T12:00:00Z'), usage(250, '2026-09-17T13:00:00Z')].map(JSON.stringify).join('\n'));
  fs.writeFileSync(path.join(root, 'rollout-a_eeee.jsonl'), [...head, usage(250, '2026-09-17T14:00:00Z'), usage(250, '2026-09-17T15:00:00Z')].map(JSON.stringify).join('\n')); // reprise qui ré-émet le cumulé : delta 0
  const db = openDatabase(path.join(directory, 'usage.sqlite'));
  const result = collectCodex(db, { root });
  assert.equal(result.sourceSessions, 1);
  assert.equal(db.prepare("SELECT SUM(total_tokens) n FROM sessions WHERE platform='codex'").get().n, 250); // 100 + 150 + 0, pas 600
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE platform='codex'").get().n, 2); // le fichier fantôme (delta 0) ne crée pas de doublon utile
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('splits Codex deltas across Paris calendar days', () => {
  const directory = temp(), file = path.join(directory, 'rollout-cross-day.jsonl');
  const usage = (total, at) => ({ timestamp: at, type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total } } } });
  const rows = [
    { timestamp: '2026-09-17T21:58:00Z', type: 'session_meta', payload: { session_id: 'cross-day', timestamp: '2026-09-17T21:58:00Z', cwd: 'C:/x', originator: 'Codex CLI' } },
    { timestamp: '2026-09-17T21:58:00Z', type: 'turn_context', payload: { model: 'gpt-test' } },
    usage(0, '2026-09-17T21:58:00Z'), usage(100, '2026-09-17T21:59:00Z'), usage(250, '2026-09-17T22:01:00Z'),
  ];
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const parsed = parseCodexSession(file);
  assert.deepEqual(parsed.map((row) => [row.startedAt, row.total]), [
    ['2026-09-17T21:59:00Z', 100],
    ['2026-09-17T22:01:00Z', 150],
  ]);
  assert.deepEqual(parsed.map((row) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(row.startedAt))), ['2026-09-17', '2026-09-18']);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('applies project override for the referenced-chatgpt handoff session', () => {
  const directory = temp(), root = path.join(directory, 'sessions'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'rollout-b.jsonl');
  const rows = [
    { timestamp: '2026-09-16T10:00:00Z', type: 'session_meta', payload: { session_id: 'over-1', timestamp: '2026-09-16T10:00:00Z', cwd: 'C:/Users/noebr/Documents/Codex/2026-09-16/referenced-chatgpt-conversation-this-is-an', originator: 'Codex CLI' } },
    { timestamp: '2026-09-16T10:01:00Z', type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 } } } },
    { timestamp: '2026-09-16T10:02:00Z', type: 'event_msg', payload: { info: { total_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 } } } }
  ]; fs.writeFileSync(file, rows.map(JSON.stringify).join('\n'));
  const db = openDatabase(path.join(directory, 'usage.sqlite'));
  collectCodex(db, { root });
  assert.equal(db.prepare("SELECT project FROM sessions WHERE id='over-1'").get().project, 'C:\\Users\\noebr\\Documents\\Documents\\Projets\\ePortfolio');
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('auto-adds missing models to pricing without duplicates', () => {
  const directory = temp(), db = openDatabase(path.join(directory, 'usage.sqlite'));
  const session = (id, platform, model) => ({ platform, agent: 'Test', id, sourcePath: id, model, input: 10, cached: 0, output: 5, reasoning: 0, total: 15 });
  importSessions(db, [session('a', 'codex', 'gpt-new'), session('b', 'opencode', 'gpt-new'), session('c', 'codex', null)]);
  const rows = db.prepare("SELECT platform, model, input_usd_per_million FROM model_pricing WHERE model='gpt-new' ORDER BY platform").all();
  assert.deepEqual(rows.map((r) => r.platform), ['codex', 'opencode']);
  assert.ok(rows.every((r) => r.input_usd_per_million === 0));
  importSessions(db, [session('a', 'codex', 'gpt-new')]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM model_pricing WHERE model='gpt-new'").get().n, 2);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});
