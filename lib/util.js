// Shared helpers: errors, validation, crypto, TOTP, CSV, templating, time zones, SSRF-safe fetch.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { SECRET } = require('./db');

class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const bad = (msg, code = 400, extra) => { throw new HttpError(code, msg, extra); };
const clean = v => (typeof v === 'string' ? v.trim().slice(0, 10000) : v);
const emailOk = e => typeof e === 'string' && e.length <= 254 && /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(e);
const normEmail = e => (typeof e === 'string' && e.trim() ? e.trim().toLowerCase() : null);
const now = () => Date.now();
const isoNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const json = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Passwords (scrypt)
function hashPw(pw) { const salt = crypto.randomBytes(16); return 's1$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 64).toString('hex'); }
function verifyPw(pw, stored) {
  if (!stored || typeof pw !== 'string') return false;
  const [, s, h] = stored.split('$'); const c = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(c, Buffer.from(h, 'hex'));
}
function checkPassword(pw) { if (typeof pw !== 'string' || pw.length < 8) bad('password must be at least 8 characters'); if (pw.length > 200) bad('password too long'); }

// Symmetric encryption for stored secrets (OAuth refresh tokens, TOTP secrets)
const ENC_KEY = crypto.createHash('sha256').update(SECRET + ':enc').digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const out = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), out].map(b => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, data] = blob.split('.').map(s => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
// Signed, expiring state blobs (OAuth state, 2FA tickets)
function sign(obj, ttlMs) { const p = Buffer.from(JSON.stringify({ ...obj, exp: now() + ttlMs })).toString('base64url'); return p + '.' + hmac(SECRET, p); }
function unsign(tok) {
  const [p, s] = String(tok || '').split('.'); if (!p || !s || !safeEq(hmac(SECRET, p), s)) return null;
  const o = json(Buffer.from(p, 'base64url').toString(), null); return o && o.exp > now() ? o : null;
}

// TOTP (RFC 6238, SHA1, 6 digits, 30s)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; }
function b32decode(s) { let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function totpAt(secret, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));
function verifyTotp(secret, code) { const c = Math.floor(now() / 30000); code = String(code || '').replace(/\s/g, ''); return [-1, 0, 1].some(d => safeEq(totpAt(secret, c + d), code)); }

// CSV (RFC 4180)
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false; text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
function toCsv(rows) {
  // Prefix formula-leading cells to prevent CSV injection in spreadsheet apps.
  const cell = v => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// {{a.b}} templating for emails/workflows
function render(tpl, ctx) {
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    let v = ctx; for (const k of path.split('.')) v = v == null ? undefined : v[k];
    return v == null ? '' : String(v);
  });
}
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Time zones: convert a wall-clock time in an IANA zone to a UTC Date.
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
}
function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz);
  return new Date(t);
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

// SSRF-guarded fetch for user-supplied URLs (webhooks, enrichment, Slack).
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return privateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('ff');
}
async function assertPublicUrl(u) {
  let url; try { url = new URL(u); } catch { bad('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) bad('URL must be http(s)');
  if (process.env.ALLOW_PRIVATE_URLS === '1') return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => bad('cannot resolve host'));
  if (addrs.some(a => privateIp(a.address))) bad('URL resolves to a private address');
  return url;
}
async function safeFetch(u, opts = {}, maxBytes = 1e6) {
  let url = await assertPublicUrl(u);
  for (let hop = 0; hop < 4; hop++) {
    const r = await fetch(url, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(opts.timeout || 8000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = await assertPublicUrl(new URL(r.headers.get('location'), url).href); continue; }
    const reader = r.body?.getReader(); const chunks = []; let size = 0;
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { reader.cancel(); break; } chunks.push(value); }
    return { status: r.status, ok: r.ok, headers: r.headers, text: Buffer.concat(chunks).toString('utf8') };
  }
  bad('too many redirects');
}

module.exports = { HttpError, bad, clean, emailOk, normEmail, now, isoNow, json, randomToken, sha256, hmac, safeEq, hashPw, verifyPw, checkPassword,
  encrypt, decrypt, sign, unsign, newTotpSecret, verifyTotp, totpAt, parseCsv, toCsv, render, firstName, escHtml, zonedToUtc, tzOffsetMs, validTz, safeFetch, assertPublicUrl };
