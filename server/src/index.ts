import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { ScanStore, hasScans } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const firstRun = !hasScans(dataDir);
const store = new ScanStore(dataDir);
const port = Number(process.env.PORT) || 4000;

if (firstRun && process.env.DEMO_SCAN !== '0') store.start({ type: 'local', paths: [path.resolve('samples/microservices')] }, 'Demo: sample microservices');

createApp(store, path.resolve(here, '../web')).listen(port, () => console.log(`api-traceability listening on http://localhost:${port}`));
