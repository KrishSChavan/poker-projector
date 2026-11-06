import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/app.js';

const SHUTDOWN_LIMIT_MS = 3000;

const root = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
// Render fills in its own address. Anywhere else, set PUBLIC_URL.
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || null;
const hostPassword = process.env.HOST_PASSWORD || null;

const server = await startServer({ port, dataDir, publicUrl, hostPassword }).catch((error) => {
  const taken =
    `Port ${port} is already in use. The app may already be running at ` +
    `http://localhost:${port}. A second copy needs its own PORT and DATA_DIR.`;
  console.error(error.code === 'EADDRINUSE' ? taken : error);
  process.exit(1);
});

// Hosted logs are kept on someone else's servers, so the pairing code stays out of them.
if (server.publicUrl) {
  console.log(`Poker Projection running at ${server.publicUrl}`);
} else {
  console.log(`Poker Projection running at http://localhost:${server.port}`);
  console.log(`Phone: ${server.phoneUrl()}`);
}

async function shutDown() {
  setTimeout(() => process.exit(1), SHUTDOWN_LIMIT_MS).unref();
  const saved = await server.close();
  if (!saved) console.error('Stopped with changes that could not be saved.');
  process.exit(0);
}

process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);
