import path from 'node:path';
import fs from 'node:fs';
import { collectCodex, openDatabase } from './collector.js';
import { defaultDataDirectory } from './storage.js';

const root = process.cwd(), dataDir = defaultDataDirectory(root);
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, 'usage.sqlite'));
console.log(JSON.stringify(collectCodex(db), null, 2));
db.close();
