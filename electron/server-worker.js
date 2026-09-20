import { startServer, stopServer } from '../src/server.js';

const parentPort = process.parentPort;
const messageData = (event) => event?.data ?? event;

if (!parentPort) throw new Error('Electron parent port unavailable');

try {
  const { url } = await startServer();
  parentPort.postMessage({ type: 'ready', url });
  parentPort.on('message', async (event) => {
    if (messageData(event)?.type !== 'stop') return;
    await stopServer();
    parentPort.postMessage({ type: 'stopped' });
    process.exit(0);
  });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
  process.exitCode = 1;
}
