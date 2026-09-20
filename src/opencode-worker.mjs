import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, collectCodex, collectOpenCode } from './collector.js';

const mode = process.argv[2];
const source = process.argv[3];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-opencode-'));
const database = path.join(directory, 'usage.sqlite');
let db;

try {
  db = openDatabase(database);
  const result = mode === 'codex' ? collectCodex(db, { root: source }) : collectOpenCode(db, { file: source });
  const sessions = db.prepare(`
    SELECT id, platform, provider, agent, source_path, project, model, started_at, ended_at,
      duration_seconds, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      total_tokens, reported_cost_usd
    FROM sessions WHERE platform=?
  `).all(mode === 'codex' ? 'codex' : 'opencode');
  process.stdout.write(JSON.stringify({ result, sessions }));
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
