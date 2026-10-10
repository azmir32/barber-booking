// Serves the one-file demo (dist-demo/index.html) the way an embedding host
// might: in a sandboxed iframe, from a sub-path, under a strict
// Content-Security-Policy with no network access and no browser dialogs.
//
//   /host  a page holding the iframe
//   *      the demo page itself (like a host's catch-all)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.DEMO_PORT ?? 54330);
const page = fs.readFileSync(path.resolve(import.meta.dirname, '../../dist-demo/index.html'));

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const host = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html, body { margin: 0; height: 100%; } iframe { border: 0; width: 100%; height: 100%; display: block; }</style>
</head><body>
<iframe id="app" title="PotongKu demo" src="/artifact/demo-page/index.html"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
</body></html>`;

http
  .createServer((req, res) => {
    if (req.url === '/host') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(host);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
    res.end(page);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Demo on http://127.0.0.1:${PORT}/host`));
