import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, Tray, nativeImage, utilityProcess } from 'electron';

const singleInstance = app.requestSingleInstanceLock();
const electronDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(electronDir, '..');
if (!singleInstance) {
  app.quit();
}

let tray;
let window;
let serverProcess;
let quitting = false;

function migrateDatabase(targetDir) {
  const targetDatabase = path.join(targetDir, 'usage.sqlite');
  if (fs.existsSync(targetDatabase)) return;

  const sourceDir = path.join(appRoot, 'data');
  const sourceDatabase = path.join(sourceDir, 'usage.sqlite');
  if (!fs.existsSync(sourceDatabase)) return;

  fs.mkdirSync(targetDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${sourceDatabase}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${targetDatabase}${suffix}`);
  }
}

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(appRoot, 'assets', 'tray.png'));
  if (icon.isEmpty()) throw new Error('Tray icon could not be loaded');
  return icon;
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function toggleWindow() {
  if (window?.isVisible()) window.hide();
  else showWindow();
}

function createWindow(url) {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: '#f7f6f1',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadURL(url);
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('AI Usage Monitor');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir le dashboard', click: showWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => app.quit() },
  ]));
  tray.on('click', toggleWindow);
  tray.on('double-click', showWindow);
}

const messageData = (event, message) => message ?? event?.data ?? event;

function startServerProcess() {
  const workerPath = path.join(electronDir, 'server-worker.js');
  serverProcess = utilityProcess.fork(workerPath, [], { serviceName: 'AI Usage Monitor server', stdio: 'pipe' });
  serverProcess.stderr?.on('data', (chunk) => console.error(`Server worker: ${chunk}`));
  serverProcess.stdout?.on('data', (chunk) => console.log(`Server worker: ${chunk}`));
  return new Promise((resolve, reject) => {
    const onMessage = (event, message) => {
      const data = messageData(event, message);
      if (data?.type === 'ready') {
        serverProcess.off('exit', onExit);
        resolve(data.url);
      }
      if (data?.type === 'error') reject(new Error(data.message));
    };
    const onExit = (code) => reject(new Error(`Server worker stopped during startup (${code ?? 'unknown'})`));
    serverProcess.on('message', onMessage);
    serverProcess.once('exit', onExit);
  });
}

function stopServerProcess() {
  if (!serverProcess) return Promise.resolve();
  const processToStop = serverProcess;
  serverProcess = null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { processToStop.kill(); resolve(); }, 5000);
    processToStop.once('exit', () => { clearTimeout(timer); resolve(); });
    processToStop.postMessage({ type: 'stop' });
  });
}

async function start() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  migrateDatabase(dataDir);
  process.env.AI_USAGE_DATA_DIR = dataDir;

  const url = await startServerProcess();
  createWindow(url);
  createTray();
}

if (singleInstance) {
  app.on('second-instance', showWindow);
  app.whenReady().then(start).catch((error) => {
    console.error(`AI Usage Monitor failed to start: ${error.message}`);
    app.quit();
  });

  app.on('before-quit', async (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    tray?.destroy();
    await stopServerProcess();
    app.quit();
  });
}
