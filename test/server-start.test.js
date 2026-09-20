import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('serves the dashboard before the initial collection finishes', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-server-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', AI_USAGE_DATA_DIR: dataDir },
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
    const data = await (await fetch(url + '/api/data?period=1', { signal: AbortSignal.timeout(1000) })).json();
    assert.equal(data.activityVersion, 2);
    assert.equal(data.activity.length, 168);
    assert.equal(data.activity.every((cell) => Number.isInteger(cell.dayIndex) && cell.dayIndex >= 0 && cell.dayIndex < 7 && cell.hour >= 0 && cell.hour < 24), true);
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
