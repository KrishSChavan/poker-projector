// The HTTP side: the pages, plus the one route that gives away the pairing code.

import express from 'express';
import QRCode from 'qrcode';
import { isAllowedHost, isLoopback, phoneAddresses, phoneUrl } from './network.js';

async function pairingDetails(port, code) {
  const addresses = phoneAddresses();
  const url = phoneUrl(addresses[0], port, code);
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1 });
  return { url, code, qrSvg, addresses };
}

export function createWebApp({ publicDir, port, gate }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (isAllowedHost(req.headers.host, port)) next();
    else res.status(403).type('text/plain').send('Forbidden');
  });

  app.get('/api/pairing', async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'Only this computer can read the pairing code.' });
      return;
    }
    res.set('Cache-Control', 'no-store').json(await pairingDetails(port, gate.code));
  });

  app.use(express.static(publicDir, { extensions: ['html'] }));
  return app;
}
