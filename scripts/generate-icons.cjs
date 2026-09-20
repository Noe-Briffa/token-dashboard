const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');

function iconFile(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map(({ data }) => data)]);
}

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, width: 256, height: 256, webPreferences: { offscreen: true } });
  return window.loadFile(path.join(assets, 'logo.svg')).then(() => window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 })).then((source) => {
    window.destroy();
    if (source.isEmpty()) throw new Error('Logo SVG could not be rasterized');
    const images = [16, 32, 48, 256].map((size) => ({ size, data: source.resize({ width: size, height: size }).toPNG() }));
    fs.writeFileSync(path.join(assets, 'tray.png'), images[1].data);
    fs.writeFileSync(path.join(assets, 'icon.ico'), iconFile(images));
  });
}).then(() => app.quit()).catch((error) => { console.error(error); app.exit(1); });
