// Outbound email: queueing, provider adapters (Gmail via the rep's own mailbox, Resend, Postmark, or log-only), open tracking, unsubscribe.
const { one, run, insert } = require('./db');
const { randomToken, escHtml, bad, isoNow, render, firstName } = require('./util');

const APP_URL = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const MAIL_FROM = () => process.env.MAIL_FROM || 'PipelineHQ <no-reply@example.com>';
function providerName() { return process.env.RESEND_API_KEY ? 'resend' : process.env.POSTMARK_TOKEN ? 'postmark' : 'log'; }
const mailConfigured = () => providerName() !== 'log';

function toHtml(text, trackToken, unsubscribe) {
  const body = escHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
  const unsub = unsubscribe ? `<p style="color:#888;font-size:12px;margin-top:24px"><a href="${APP_URL()}/u/${trackToken}">Unsubscribe</a></p>` : '';
  const pixel = trackToken ? `<img src="${APP_URL()}/t/${trackToken}.gif" width="1" height="1" alt="" style="display:none">` : '';
  return `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${body}${unsub}${pixel}</div>`;
}

// Low-level send through the configured transactional provider.
async function providerSend({ from, to, subject, text, html, replyTo }) {
  const p = providerName();
  if (p === 'resend') {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html, reply_to: replyTo }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `Resend error ${r.status}`); return { provider: 'resend', id: j.id };
  }
  if (p === 'postmark') {
    const r = await fetch('https://api.postmarkapp.com/email', { method: 'POST', headers: { 'X-Postmark-Server-Token': process.env.POSTMARK_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: text, HtmlBody: html, ReplyTo: replyTo, MessageStream: 'outbound' }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.Message || `Postmark error ${r.status}`); return { provider: 'postmark', id: j.MessageID };
  }
  if (process.env.NODE_ENV !== 'test') console.log(`[mail:log] to=${to} subject=${JSON.stringify(subject)}`);
  return { provider: 'log', id: null, simulated: true };
}

// Queue an email to a contact; the worker sends it. Returns the emails row id.
function queueEmail({ orgId, user, contact, dealId = null, subject, body, enrollmentId = null }) {
  if (!contact?.email) bad('contact has no email address');
  if (contact.unsubscribed) bad('contact has unsubscribed from email');
  const token = randomToken(18);
  const id = insert('emails', { org_id: orgId, contact_id: contact.id, deal_id: dealId, user_id: user?.id ?? null, direction: 'out',
    from_addr: user?.google_email || user?.email || null, to_addr: contact.email, subject: String(subject).slice(0, 500), body: String(body).slice(0, 50000),
    status: 'queued', track_token: token, enrollment_id: enrollmentId });
  require('./core').enqueue('send_email', { email_id: id });
  return id;
}

// Worker: actually deliver one queued email.
async function deliver(emailId) {
  const e = one('SELECT * FROM emails WHERE id=?', emailId); if (!e || e.status !== 'queued') return;
  const user = e.user_id ? one('SELECT * FROM users WHERE id=?', e.user_id) : null;
  const html = toHtml(e.body, e.track_token, !!e.enrollment_id);
  try {
    let res;
    if (user?.google_refresh && process.env.GOOGLE_CLIENT_ID) res = await require('./google').gmailSend(user, { to: e.to_addr, subject: e.subject, html, text: e.body });
    else {
      const addr = (MAIL_FROM().match(/<([^>]+)>/) || [, MAIL_FROM()])[1];
      const from = user ? `"${user.name.replace(/["\r\n]/g, '')}" <${addr}>` : MAIL_FROM();
      res = await providerSend({ from, to: e.to_addr, subject: e.subject, text: e.body, html, replyTo: user?.email });
    }
    run('UPDATE emails SET status=?, provider=?, message_id=COALESCE(message_id,?), sent_at=?, error=NULL WHERE id=?', res.simulated ? 'logged' : 'sent', res.provider, res.id, isoNow(), e.id);
    require('./core').emit(e.org_id, 'email.sent', { email: { id: e.id, contact_id: e.contact_id, subject: e.subject } });
  } catch (err) {
    run("UPDATE emails SET status='failed', error=? WHERE id=?", String(err.message).slice(0, 500), e.id);
    throw err;
  }
}

// System mail (invites, password resets, notifications) — not tracked.
async function sendSystem({ to, subject, text }) { return providerSend({ from: MAIL_FROM(), to, subject, text, html: toHtml(text) }); }

// Context for {{merge.fields}}
function mergeContext(contact, deal, user) {
  const company = contact?.company_id ? one('SELECT * FROM companies WHERE id=?', contact.company_id) : null;
  return { contact: { ...contact, first_name: firstName(contact?.name) }, company: company || {}, deal: deal || {}, user: user || {} };
}
const renderTemplate = (tpl, ctx) => ({ subject: render(tpl.subject, ctx), body: render(tpl.body, ctx) });

module.exports = { queueEmail, deliver, sendSystem, providerSend, mergeContext, renderTemplate, mailConfigured, providerName, APP_URL };
