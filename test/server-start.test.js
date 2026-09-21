import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importOpenCodeSkillEvents, importSessions, openDatabase } from '../src/collector.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('serves the dashboard before the initial collection finishes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-server-'));
  const database = openDatabase(path.join(dataDir, 'usage.sqlite'));
  importSessions(database, [
    { platform: 'opencode', agent: 'explore', id: 'opencode:session-1:gpt-test:2026-09-18:10', sourcePath: 'segment-1', startedAt: '2026-09-18T12:00:00.000Z', total: 10 },
    { platform: 'opencode', agent: 'explore', id: 'opencode:session-1:gpt-test:2026-09-18:11', sourcePath: 'segment-2', startedAt: '2026-09-18T12:30:00.000Z', total: 10 },
    { platform: 'opencode', agent: 'build', id: 'opencode:session-2', sourcePath: 'session-2', startedAt: '2026-09-19T12:00:00.000Z', total: 10 },
    { platform: 'opencode', agent: 'general', id: 'opencode:session-3', sourcePath: 'session-3', startedAt: '2026-09-18T13:00:00.000Z', total: 10 },
  ]);
  importOpenCodeSkillEvents(database, [
    { id: 'skill-1', day: '2026-09-18', skill: 'caveman', agent: 'plan', time_created: Date.parse('2026-09-18T14:00:00.000Z') },
    { id: 'skill-2', day: '2026-09-18', skill: 'caveman', agent: 'build', time_created: Date.parse('2026-09-18T14:01:00.000Z') },
  ]);
  database.close();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', AI_USAGE_DATA_DIR: dataDir, AI_USAGE_LEGACY_DATA_DIR: path.join(dataDir, 'legacy') },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    let output = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 5000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('error', reject);
      child.once('exit', (code) => { if (code !== null) reject(new Error(`server exited with ${code}`)); });
    });
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    const favicon = await fetch(url + '/favicon.svg', { signal: AbortSignal.timeout(1000) });
    assert.equal(favicon.status, 200);
    assert.match(favicon.headers.get('content-type') || '', /^image\/svg\+xml/);
    assert.match(await favicon.text(), /AI Usage Monitor/);
    const data = await (await fetch(url + '/api/data?from=2026-09-01&to=2026-09-02&activityFrom=2026-09-14&activityTo=2026-09-20', { signal: AbortSignal.timeout(1000) })).json();
    assert.equal(data.activityVersion, 3);
    assert.equal(typeof data.skillSource.eventCount, 'number');
    assert.equal(typeof data.skillSource.cacheAvailable, 'boolean');
    assert.equal(typeof data.skillSource.status, 'string');
    assert.deepEqual(data.activityRange, { start: '2026-09-14', end: '2026-09-20' });
    assert.equal(data.activity.length, 168);
    assert.equal(data.activity.every((cell) => Number.isInteger(cell.dayIndex) && cell.dayIndex >= 0 && cell.dayIndex < 7 && cell.hour >= 0 && cell.hour < 24), true);
    const agents = await (await fetch(url + '/api/data?from=2026-09-18&to=2026-09-19', { signal: AbortSignal.timeout(1000) })).json();
    assert.deepEqual(agents.agentDaily, [
      { day: '2026-09-18', agents: [{ agent: 'explore', sessions: 1 }] },
      { day: '2026-09-19', agents: [] },
    ]);
    assert.deepEqual(agents.skillDaily, [
      { day: '2026-09-18', skills: [{ skill: 'caveman', agent: 'build', activations: 1 }, { skill: 'caveman', agent: 'plan', activations: 1 }] },
      { day: '2026-09-19', skills: [] },
    ]);
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('starts and stops as an embeddable server', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-monitor-'));
  process.env.AI_USAGE_DATA_DIR = dataDir;
  const { startServer, stopServer } = await import(`../src/server.js?test=${Date.now()}`);
  try {
    const { url } = await startServer({ port: 0 });
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(1000) })).status, 200);
  } finally {
    await stopServer();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.AI_USAGE_DATA_DIR;
  }
});
