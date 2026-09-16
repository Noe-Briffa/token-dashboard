import path from 'node:path';
import fs from 'node:fs';
import { collectCodex, openDatabase } from './collector.js';

const root = process.cwd(), dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = openDatabase(path.join(dataDir, 'usage.sqlite'));
console.log(JSON.stringify(collectCodex(db), null, 2));
db.close();
