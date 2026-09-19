import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('serves the dashboard before the initial collection finishes', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
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
  } finally {
    child.kill();
  }
});
