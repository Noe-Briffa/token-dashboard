import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, collectCodex, collectOpenCode, readOpenCodeSkillEvents } from './collector.js';

const mode = process.argv[2];
const source = process.argv[3];
const skillSinceMs = Number(process.argv[4]) || 0;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-opencode-'));
const database = path.join(directory, 'usage.sqlite');
let db;

try {
  db = openDatabase(database);
  if (mode === 'opencode-skills') {
    process.stdout.write(JSON.stringify({ skillEvents: readOpenCodeSkillEvents(source, skillSinceMs) }));
  } else {
    const result = mode === 'codex' ? collectCodex(db, { root: source }) : collectOpenCode(db, { file: source, collectSkills: false });
    const sessions = db.prepare(`
      SELECT id, platform, provider, agent,
        source_path AS sourcePath, project, model,
        started_at AS startedAt, ended_at AS endedAt,
        duration_seconds AS durationSeconds,
        input_tokens AS input, cached_input_tokens AS cached,
        output_tokens AS output, reasoning_tokens AS reasoning,
        total_tokens AS total, reported_cost_usd AS reportedCost
        , model_calls AS modelCalls
      FROM sessions WHERE platform=?
    `).all(mode === 'codex' ? 'codex' : 'opencode');
    process.stdout.write(JSON.stringify({ result, sessions, skillEvents: [] }));
  }
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(directory, { recursive: true, force: true });
}
