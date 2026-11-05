// Google OAuth (SSO login + Gmail connect), Gmail send and Gmail inbox sync. Active only when GOOGLE_CLIENT_ID/SECRET are set.
const { q, one, run } = require('./db');
const { encrypt, decrypt, sign, now } = require('./util');
const { APP_URL } = require('./email');

const enabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const REDIRECT = () => `${APP_URL()}/auth/google/callback`;
const GMAIL_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';

function authUrl(mode, userId) {
  const state = sign({ mode, uid: userId || null }, 10 * 60e3);
  const p = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT(), response_type: 'code', state,
    scope: 'openid email profile' + (mode === 'connect' ? ' ' + GMAIL_SCOPES : ''), ...(mode === 'connect' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }) });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}
async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }), signal: AbortSignal.timeout(15000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.error || 'Google token error'); return j;
}
// Exchange the auth code; the id_token comes straight from Google's token endpoint over TLS, so its claims can be read without re-verifying the signature.
async function exchange(code) {
  const t = await tokenRequest({ code, redirect_uri: REDIRECT(), grant_type: 'authorization_code' });
  const claims = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString());
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID || !claims.email_verified) throw new Error('Google account email is not verified');
  return { email: claims.email.toLowerCase(), name: claims.name || claims.email, refresh: t.refresh_token || null };
}
async function accessToken(user) {
  const t = await tokenRequest({ refresh_token: decrypt(user.google_refresh), grant_type: 'refresh_token' }); return t.access_token;
}
function saveConnection(userId, email, refresh) { if (refresh) run('UPDATE users SET google_refresh=?, google_email=?, gmail_synced_at=? WHERE id=?', encrypt(refresh), email, now() - 2 * 864e5, userId); }

const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
async function gmailSend(user, { to, subject, html, text }) {
  const b = 'b' + now();
  const mime = [`From: ${encWord(user.name)} <${user.google_email}>`, `To: ${to}`, `Subject: ${encWord(subject)}`, 'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(text).toString('base64'), `--${b}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html).toString('base64'), `--${b}--`].join('\r\n');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${await accessToken(user)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || 'Gmail send failed');
  return { provider: 'gmail', id: 'gmail:' + j.id };
}

function bodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const p of payload.parts || []) { const t = bodyText(p); if (t) return t; }
  return '';
}
const addrs = s => (String(s || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map(a => a.toLowerCase());

// Pull recent mail and log anything to/from a known contact onto the timeline.
async function syncUser(user) {
  const token = await accessToken(user), auth = { Authorization: `Bearer ${token}` };
  const after = Math.floor((user.gmail_synced_at || now() - 2 * 864e5) / 1000) - 300;
  const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent('after:' + after)}`, { headers: auth, signal: AbortSignal.timeout(20000) })).json();
  let logged = 0;
  for (const m of list.messages || []) {
    if (one('SELECT 1 FROM emails WHERE org_id=? AND message_id=?', user.org_id, 'gmail:' + m.id)) continue;
    const msg = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: auth, signal: AbortSignal.timeout(20000) })).json();
    const H = Object.fromEntries((msg.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
    const r = require('./inbound').record(user.org_id, { from: addrs(H.from)[0], to: [...addrs(H.to), ...addrs(H.cc)], subject: H.subject, text: bodyText(msg.payload),
      messageId: 'gmail:' + m.id, userId: user.id, at: new Date(Number(msg.internalDate)).toISOString() });
    if (r) logged++;
  }
  run('UPDATE users SET gmail_synced_at=? WHERE id=?', now(), user.id);
  return logged;
}
async function syncAll() {
  if (!enabled()) return;
  for (const u of q('SELECT * FROM users WHERE google_refresh IS NOT NULL AND active=1')) {
    try { await syncUser(u); } catch (e) { console.error('gmail sync failed for user', u.id, e.message); }
  }
}

module.exports = { enabled, authUrl, exchange, saveConnection, gmailSend, syncUser, syncAll };
