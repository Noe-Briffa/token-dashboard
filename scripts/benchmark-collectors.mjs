import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { collectCodex, collectOpenCode, openDatabase } from '../src/collector.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-benchmark-'));
const db = openDatabase(path.join(directory, 'usage.sqlite'));
const snapshot = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const run = (label, callback) => {
  const before = snapshot(), started = performance.now();
  const result = callback();
  if (global.gc) global.gc();
  console.log(JSON.stringify({ label, ms: Math.round(performance.now() - started), rssBeforeMb: before, rssAfterMb: snapshot(), result }));
};

try {
  if (!process.argv.includes('--opencode')) run('codex-first', () => collectCodex(db));
  run('opencode-first', () => collectOpenCode(db));
  if (!process.argv.includes('--opencode')) run('codex-second', () => collectCodex(db));
  run('opencode-second', () => collectOpenCode(db));
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
