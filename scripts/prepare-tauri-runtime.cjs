const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'src-tauri', 'runtime', 'node.exe');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(process.execPath, target);
console.log(`Prepared Tauri Node runtime: ${target}`);
