import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCosts, cost, missingPriceCond, tokenTotal } from '../src/costs.js';
import { importSessions, openDatabase } from '../src/collector.js';

// Non-regression : le raisonnement Codex est inclus dans la sortie,
// jamais ajoute (total = input + output). OpenCode garde des compteurs disjoints.
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-cost-'));
const fresh = () => { const directory = temp(); return { directory, db: openDatabase(path.join(directory, 'usage.sqlite')) }; };
const join = "FROM sessions s LEFT JOIN model_pricing p ON p.platform=s.platform AND p.model=COALESCE(s.model, '')";
const seed = (db, platform, model, input, cached, output, reasoning) => db.prepare("INSERT INTO model_pricing (platform, model, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, reasoning_usd_per_million, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(platform, model) DO UPDATE SET input_usd_per_million=excluded.input_usd_per_million, cached_input_usd_per_million=excluded.cached_input_usd_per_million, output_usd_per_million=excluded.output_usd_per_million, reasoning_usd_per_million=excluded.reasoning_usd_per_million").run(platform, model, input, cached, output, reasoning);

test('codex cost counts reasoning inside output, immune to reasoning tariff', () => {
  const { directory, db } = fresh();
  importSessions(db, [{ platform: 'codex', agent: 'Codex CLI', id: 'c1', sourcePath: 'c1', model: 'gpt-cost', input: 100, cached: 60, output: 20, reasoning: 10, total: 120 }]);
  seed(db, 'codex', 'gpt-cost', 2, 0.2, 4, 99);
  const got = db.prepare(`SELECT SUM(${cost}) api, SUM(${tokenTotal}) total ${join}`).get();
  assert.equal(got.total, 120);
  assert.equal(got.api, 0.000172); // (100-60)*2 + 60*0.2 + 20*4, tarif raisonnement 99 sans effet
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('opencode cost keeps disjoint counters with distinct reasoning tariff', () => {
  const { directory, db } = fresh();
  importSessions(db, [{ platform: 'opencode', agent: 'OpenCode', id: 'o1', sourcePath: 'o1', model: 'gpt-cost', input: 100, cached: 75, output: 25, reasoning: 15, total: 215 }]);
  seed(db, 'opencode', 'gpt-cost', 2, 0.2, 4, 4);
  const got = db.prepare(`SELECT SUM(${cost}) api, SUM(${tokenTotal}) total ${join}`).get();
  assert.equal(got.total, 215);
  assert.equal(got.api, 0.000375); // 100*2 + 75*0.2 + 25*4 + 15*4
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('codex cost split carries full output and zero reasoning', () => {
  const { directory, db } = fresh();
  importSessions(db, [{ platform: 'codex', agent: 'Codex CLI', id: 'c1', sourcePath: 'c1', model: 'gpt-cost', input: 100, cached: 60, output: 20, reasoning: 10, total: 120 }]);
  seed(db, 'codex', 'gpt-cost', 2, 0.2, 4, 4);
  const price = buildCosts(false);
  const got = db.prepare(`SELECT SUM(${price.part.output}) out, SUM(${price.part.reasoning}) reas ${join}`).get();
  assert.equal(got.out, 0.00008);
  assert.equal(got.reas, 0);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('reported cost keeps priority over estimate on both platforms', () => {
  const { directory, db } = fresh();
  importSessions(db, [
    { platform: 'codex', agent: 'Codex CLI', id: 'c1', sourcePath: 'c1', model: 'gpt-cost', input: 100, cached: 0, output: 10, reasoning: 5, total: 110, reportedCost: 0.5 },
    { platform: 'opencode', agent: 'OpenCode', id: 'o1', sourcePath: 'o1', model: 'gpt-cost', input: 100, cached: 0, output: 10, reasoning: 5, total: 115, reportedCost: 0.25 },
  ]);
  seed(db, 'codex', 'gpt-cost', 2, 0.2, 4, 4);
  seed(db, 'opencode', 'gpt-cost', 2, 0.2, 4, 4);
  const got = db.prepare(`SELECT SUM(${cost}) api ${join}`).get();
  assert.equal(got.api, 0.75);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('missing price exempts codex reasoning tariff but not opencode', () => {
  const { directory, db } = fresh();
  importSessions(db, [
    { platform: 'codex', agent: 'Codex CLI', id: 'c1', sourcePath: 'c1', model: 'gpt-partial', input: 100, cached: 0, output: 10, reasoning: 5, total: 110 },
    { platform: 'opencode', agent: 'OpenCode', id: 'o1', sourcePath: 'o1', model: 'gpt-noprice', input: 100, cached: 0, output: 10, reasoning: 5, total: 115 },
  ]);
  seed(db, 'codex', 'gpt-partial', 2, 0.2, 4, 0);
  const got = db.prepare(`SELECT COALESCE(SUM(CASE WHEN ${missingPriceCond} THEN ${tokenTotal} ELSE 0 END),0) missing ${join}`).get();
  assert.equal(got.missing, 115); // seule la ligne opencode sans prix alerte
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});
test('free models never inherit family pricing', () => {
  const { directory, db } = fresh();
  importSessions(db, [{ platform: 'codex', agent: 'Codex CLI', id: 'f1', sourcePath: 'f1', model: 'muse-spark-9-free', input: 100, cached: 0, output: 10, reasoning: 0, total: 110 }]);
  const row = db.prepare("SELECT input_usd_per_million, output_usd_per_million FROM model_pricing WHERE platform='codex' AND model='muse-spark-9-free'").get();
  assert.equal(row.input_usd_per_million, 0);
  assert.equal(row.output_usd_per_million, 0);
  db.close(); fs.rmSync(directory, { recursive: true, force: true });
});
