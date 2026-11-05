// PipelineHQ — multi-tenant SaaS sales CRM. Entry point: HTTP server, static SPA, API routes, background worker.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Router, handle } = require('./lib/http');
const { HttpError } = require('./lib/util');

const router = new Router();
require('./routes/public')(router);
require('./routes/auth')(router);
require('./routes/records')(router);
require('./routes/sales')(router);
require('./routes/admin')(router);
router.get('/healthz', { auth: false }, () => ({ ok: true }));

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const isApi = p => /^\/(api|auth|f|book|q|t|u|cal|healthz)(\/|$)/.test(p);

const server = http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.COOKIE_SECURE === '1') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  try {
    if (!isApi(url.pathname)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(PUB, rel);
      if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new HttpError(404, 'not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY',
        'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
      return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
    }
    await handle(router, req, res, url);
  } catch (e) {
    const code = e instanceof HttpError ? e.code : e.code === 400 ? 400 : 500;
    if (code === 500) console.error(e);
    if (res.headersSent) return res.end();
    const msg = code === 500 ? 'Something went wrong on our side' : e.message;
    if (isApi(url.pathname) && (url.pathname.startsWith('/api') || String(req.headers.accept || '').includes('json') || String(req.headers['content-type'] || '').includes('json'))) {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: msg, ...(e.extra || {}) }));
    } else {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;padding:40px;max-width:600px;margin:auto"><h2>${code === 404 ? 'Not found' : 'Error'}</h2><p>${String(msg).replace(/[<>&]/g, '')}</p>`);
    }
  }
});
server.requestTimeout = 60e3;

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, () => console.log(`PipelineHQ running on http://localhost:${PORT}`));
  require('./lib/worker').start();
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = server;
