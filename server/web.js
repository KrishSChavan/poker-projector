// The HTTP side: the pages, plus the one route that gives away the pairing code.

import express from 'express';
import QRCode from 'qrcode';
import { isAllowedHost, phoneAddresses, phoneUrl } from './network.js';

const BEARER = 'Bearer ';

async function pairingDetails(port, code, publicUrl) {
  const addresses = publicUrl === null ? phoneAddresses() : [new URL(publicUrl).host];
  const url = publicUrl === null ? phoneUrl(addresses[0], port, code) : `${publicUrl}/dealer#${code}`;
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1 });
  return { url, code, qrSvg, addresses, isHosted: publicUrl !== null };
}

export function createWebApp({ publicDir, port, gate, publicUrl = null }) {
  const publicHost = publicUrl === null ? null : new URL(publicUrl).host;

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    if (isAllowedHost(req.headers.host, port, undefined, publicHost)) next();
    else res.status(403).type('text/plain').send('Forbidden');
  });

  app.get('/api/pairing', async (req, res) => {
    // A header, not a cookie, so that no other site's page can send it.
    const authorization = req.get('authorization') ?? '';
    const key = authorization.startsWith(BEARER) ? authorization.slice(BEARER.length) : null;
    if (!gate.isHost(req.socket.remoteAddress, key)) {
      res.status(403).json({ error: 'Only the host can read the pairing code.' });
      return;
    }
    const details = await pairingDetails(port, gate.code, publicUrl);
    res.set('Cache-Control', 'no-store').json(details);
  });

  app.use(express.static(publicDir, { extensions: ['html'] }));
  return app;
}
