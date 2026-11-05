// Minimal router, auth resolution (session cookie or API key), CSRF/origin checks, rate limiting, security headers.
const { one, run } = require('./db');
const { HttpError, bad, sha256, now, randomToken, json } = require('./util');
const { requireFeature } = require('./plans');

const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SUPERADMINS = (process.env.SUPERADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

// ---- rate limiting (fixed window, in-memory; use Redis when running >1 instance)
const buckets = new Map();
function rateLimit(key, max, windowMs = 60000) {
  const t = now(); let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  if (++b.n > max) throw new HttpError(429, 'Too many requests — slow down');
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; })); }
function setCookie(res, name, val, maxAge) {
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), `${name}=${encodeURIComponent(val)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`]);
}

const SESSION_TTL = 14 * 864e5;
function createSession(res, userId, impersonatorId = null) {
  const token = randomToken(32);
  run('INSERT INTO sessions(token_hash,user_id,impersonator_id,expires) VALUES(?,?,?,?)', sha256(token), userId, impersonatorId, now() + SESSION_TTL);
  setCookie(res, 'sid', token, SESSION_TTL / 1000);
  return token;
}
function destroySession(req, res) { const t = cookies(req).sid; if (t) run('DELETE FROM sessions WHERE token_hash=?', sha256(t)); setCookie(res, 'sid', '', 0); }

const USER_COLS = 'u.id,u.org_id,u.email,u.name,u.role,u.manager_id,u.phone,u.active,u.totp_enabled,u.notify_email,u.calendar_token,u.google_email,u.created_at';
function resolveAuth(req) {
  const h = req.headers.authorization;
  if (h && /^Bearer crm_/.test(h)) {
    const k = one('SELECT * FROM api_keys WHERE key_hash=?', sha256(h.slice(7).trim()));
    if (!k) throw new HttpError(401, 'invalid API key');
    const user = one(`SELECT ${USER_COLS} FROM users u WHERE u.id=? AND u.active=1`, k.user_id);
    if (!user) throw new HttpError(401, 'API key owner is deactivated');
    run('UPDATE api_keys SET last_used=CURRENT_TIMESTAMP WHERE id=?', k.id);
    return { user, via: 'api', apiKeyId: k.id };
  }
  const t = cookies(req).sid; if (!t) return null;
  const s = one('SELECT * FROM sessions WHERE token_hash=? AND expires>?', sha256(t), now()); if (!s) return null;
  const user = one(`SELECT ${USER_COLS} FROM users u WHERE u.id=? AND u.active=1`, s.user_id); if (!user) return null;
  return { user, via: 'cookie', impersonatorId: s.impersonator_id };
}
const isSuperadmin = u => !!u && SUPERADMINS.includes(u.email);

class Router {
  constructor() { this.routes = []; }
  add(method, path, opts, fn) {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const keys = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    this.routes.push({ method, re, keys, opts: { auth: true, ...opts }, fn });
  }
  get(p, o, f) { this.add('GET', p, o, f); } post(p, o, f) { this.add('POST', p, o, f); }
  patch(p, o, f) { this.add('PATCH', p, o, f); } put(p, o, f) { this.add('PUT', p, o, f); } del(p, o, f) { this.add('DELETE', p, o, f); }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path); if (!m) continue; pathMatched = true;
      if (r.method !== method) continue;
      return { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return pathMatched ? 'method' : null;
  }
}

async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, 'request body too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}

function clientIp(req) { return (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || ''; }

async function handle(router, req, res, url) {
  const ip = clientIp(req), nonce = randomToken(12);
  const ctx = { req, res, url, query: url.searchParams, ip, nonce, handled: false,
    json(obj, status = 200) { this.handled = true; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); },
    html(body, status = 200, frameable = false) {
      this.handled = true;
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors ${frameable ? '*' : "'none'"}; form-action 'self' https:` });
      res.end(body);
    },
    redirect(loc, status = 302) { this.handled = true; res.writeHead(status, { Location: loc }); res.end(); },
    send(buf, type, headers = {}) { this.handled = true; res.writeHead(200, { 'Content-Type': type, ...headers }); res.end(buf); },
  };
  const found = router.match(req.method, url.pathname);
  if (found === 'method') bad('method not allowed', 405);
  if (!found) bad('not found', 404);
  const { r, params } = found; const o = r.opts; ctx.params = params;

  if (o.rate === 'public') rateLimit('pub:' + ip, Number(process.env.RATE_LIMIT_PUBLIC || 30));
  else rateLimit('ip:' + ip, Number(process.env.RATE_LIMIT || 600));
  const auth = resolveAuth(req);
  if (auth) { Object.assign(ctx, auth); ctx.org = one('SELECT * FROM orgs WHERE id=?', auth.user.org_id); }
  if (o.auth && !auth) bad('not authenticated', 401);
  if (auth?.via === 'api') { requireFeature(ctx.org, 'api'); rateLimit('key:' + auth.apiKeyId, 300); }
  if (o.superadmin && !isSuperadmin(auth?.user) && !isSuperadmin(auth?.impersonatorId && one('SELECT email FROM users WHERE id=?', auth.impersonatorId))) bad('forbidden', 403);
  if (o.roles && !o.roles.includes(ctx.user.role)) bad('you do not have permission to do this', 403);
  if (o.feature) requireFeature(ctx.org, o.feature);

  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (mutating && auth?.via === 'cookie' && o.auth) { // CSRF defence in depth (SameSite=Lax cookies are the first line)
    const origin = req.headers.origin;
    let originHost = null; try { originHost = origin && new URL(origin).host; } catch { originHost = 'invalid'; }
    if (origin && originHost !== req.headers.host) bad('cross-origin request blocked', 403);
    if (!origin && req.headers['sec-fetch-site'] === 'cross-site') bad('cross-origin request blocked', 403);
    if (!o.raw && req.headers['content-length'] !== '0' && req.method !== 'DELETE' && !String(req.headers['content-type'] || '').includes('application/json')) bad('Content-Type must be application/json', 415);
  }
  if (mutating && req.method !== 'DELETE') {
    const raw = await readBody(req, o.maxBody || 1e6); ctx.rawBody = raw;
    if (!o.raw) {
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/x-www-form-urlencoded')) ctx.body = Object.fromEntries(new URLSearchParams(raw.toString()));
      else { ctx.body = raw.length ? json(raw.toString(), undefined) : {}; if (ctx.body === undefined || typeof ctx.body !== 'object' || ctx.body === null) bad('invalid JSON body'); }
    }
  } else ctx.body = {};
  const out = await r.fn(ctx);
  if (!ctx.handled) ctx.json(out === undefined ? { ok: true } : out);
}

module.exports = { Router, handle, createSession, destroySession, cookies, setCookie, isSuperadmin, rateLimit, clientIp };
