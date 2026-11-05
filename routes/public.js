// Public (unauthenticated) surfaces: hosted lead forms, meeting booking pages, quote view + e-signature, email open pixel,
// unsubscribe, ICS calendar feeds, inbound email webhook, Stripe webhook.
const { q, one, run, insert } = require('../lib/db');
const U = require('../lib/util');
const { bad, clean, escHtml: h, emailOk, json } = U;
const core = require('../lib/core');
const email = require('../lib/email');

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const page = (title, body, nonce, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)}</title><style>
:root{--bg:#f6f7fb;--card:#fff;--tx:#1b1f2a;--mut:#6b7280;--bd:#e5e7ef;--pri:#4f46e5}
@media(prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#181b24;--tx:#e8eaf0;--mut:#9aa1b2;--bd:#2a2e3b;--pri:#818cf8}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--tx)}main{max-width:760px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:22px}h1{font-size:22px;margin:0 0 6px}.mut{color:var(--mut)}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 4px}input,textarea,select{width:100%;padding:10px;border:1px solid var(--bd);border-radius:8px;background:var(--card);color:var(--tx);font:inherit}
button{background:var(--pri);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;cursor:pointer;margin-top:14px}button.ghost{background:transparent;color:var(--tx);border:1px solid var(--bd)}
table{width:100%;border-collapse:collapse}td,th{padding:8px 6px;border-bottom:1px solid var(--bd);text-align:left}td.n,th.n{text-align:right}
.slots{display:flex;flex-wrap:wrap;gap:8px}.slots button{margin:0;background:var(--card);color:var(--pri);border:1px solid var(--pri)}.slots button.on{background:var(--pri);color:#fff}
.day{margin:14px 0 6px;font-weight:600}.ok{color:#16a34a}.hp{position:absolute;left:-9999px}@media print{button,form{display:none}}
</style></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
const money = (v, cur) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(v || 0);
const FIELD_LABELS = { name: 'Full name', email: 'Work email', company: 'Company', phone: 'Phone', title: 'Job title', message: 'How can we help?' };

// ---------- booking slot computation
function slotsFor(bp, days = 14) {
  const tz = bp.timezone, dur = bp.duration_min, allowed = bp.days.split(',').map(Number);
  const today = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const busy = q("SELECT start_at, COALESCE(duration_min,30) dur FROM activities WHERE owner_id=? AND type='meeting' AND done=0 AND start_at>=datetime('now','-1 day')", bp.user_id)
    .map(b => { const s = new Date(b.start_at.replace(' ', 'T') + 'Z').getTime(); return [s, s + b.dur * 60e3]; });
  const out = [], minStart = Date.now() + 60 * 60e3;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + i));
    if (!allowed.includes(d.getUTCDay())) continue;
    const list = [];
    for (let m = bp.start_hour * 60; m + dur <= bp.end_hour * 60; m += dur) {
      const s = U.zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(m / 60), m % 60, tz).getTime(), e = s + dur * 60e3;
      if (s < minStart || busy.some(([bs, be]) => s < be && e > bs)) continue;
      list.push(new Date(s).toISOString());
    }
    if (list.length) out.push({ date: d.toISOString().slice(0, 10), slots: list });
  }
  return out;
}

function quoteHtml(qt, org, nonce, msg = '') {
  const t = require('./sales').quoteTotals(qt.id), deal = one('SELECT * FROM deals WHERE id=?', qt.deal_id);
  const contact = deal.contact_id ? one('SELECT * FROM contacts WHERE id=?', deal.contact_id) : null;
  const expired = qt.valid_until && qt.valid_until < new Date().toISOString().slice(0, 10);
  const open = !['accepted', 'declined'].includes(qt.status) && !expired;
  return page(`Quote ${qt.number}`, `<div class="card"><p class="mut">${h(org.name)} · Quote ${h(qt.number)}</p><h1>${h(qt.title || deal.title)}</h1>
    <p class="mut">${contact ? `Prepared for ${h(contact.name)} · ` : ''}Valid until ${h(qt.valid_until || '—')}</p>
    <table><tr><th>Item</th><th class="n">Qty</th><th class="n">Price</th><th class="n">Disc.</th><th class="n">Total</th></tr>
    ${t.items.map(i => `<tr><td>${h(i.name)}</td><td class="n">${i.qty}</td><td class="n">${money(i.unit_price, org.currency)}</td><td class="n">${i.discount_pct ? i.discount_pct + '%' : ''}</td><td class="n">${money(i.total, org.currency)}</td></tr>`).join('')}
    <tr><td colspan=4 class="n">Subtotal</td><td class="n">${money(t.subtotal, org.currency)}</td></tr>
    ${t.discount ? `<tr><td colspan=4 class="n">Discount (${qt.discount_pct}%)</td><td class="n">−${money(t.discount, org.currency)}</td></tr>` : ''}
    ${t.tax ? `<tr><td colspan=4 class="n">Tax (${qt.tax_pct}%)</td><td class="n">${money(t.tax, org.currency)}</td></tr>` : ''}
    <tr><th colspan=4 class="n">Total</th><th class="n">${money(t.total, org.currency)}</th></tr></table>
    ${qt.notes ? `<p style="white-space:pre-wrap">${h(qt.notes)}</p>` : ''}
    ${msg ? `<p class="ok"><b>${h(msg)}</b></p>` : ''}
    ${qt.status === 'accepted' ? `<p class="ok"><b>✓ Accepted by ${h(qt.signed_name)} on ${h(qt.signed_at)} UTC</b></p>` : qt.status === 'declined' ? '<p class="mut"><b>This quote was declined.</b></p>' : expired ? '<p class="mut"><b>This quote has expired.</b></p>' : ''}
    ${open ? `<form method="post" action="/q/${h(qt.token)}/accept"><label>Type your full name to sign and accept</label><input name="name" required maxlength="120" autocomplete="name">
      <label style="display:flex;gap:8px;align-items:center;color:inherit"><input type="checkbox" name="agree" required style="width:auto"> I agree to the terms of this quote and am authorized to accept it.</label>
      <button>Accept &amp; sign</button> <button class="ghost" formaction="/q/${h(qt.token)}/decline" formnovalidate>Decline</button></form>` : ''}
    <p><button class="ghost" id="pr">Print / Save as PDF</button></p></div>`, nonce, `document.getElementById('pr').onclick=()=>print()`);
}

module.exports = function (r) {
  // ---------- hosted lead forms
  r.get('/f/:key', { auth: false }, ctx => {
    const f = one('SELECT * FROM forms WHERE key=?', ctx.params.key); if (!f) bad('form not found', 404);
    const fields = json(f.fields, []), org = one('SELECT name FROM orgs WHERE id=?', f.org_id), defs = core.fieldDefs(f.org_id, 'contacts');
    const input = k => {
      if (k.startsWith('custom.')) { const d = defs.find(x => 'custom.' + x.key === k); if (!d) return ''; return `<label>${h(d.label)}</label>${d.type === 'select' ? `<select name="${h(k)}"><option></option>${d.options.map(o => `<option>${h(o)}</option>`).join('')}</select>` : `<input name="${h(k)}">`}`; }
      return `<label>${h(FIELD_LABELS[k] || k)}</label>${k === 'message' ? '<textarea name="message" rows="4"></textarea>' : `<input name="${k}" ${k === 'email' ? 'type="email" required' : k === 'name' ? 'required' : ''}>`}`;
    };
    ctx.html(page(f.name, `<div class="card"><h1>${h(f.name)}</h1><p class="mut">${h(org.name)}</p><form method="post">${fields.map(input).join('')}
      <input class="hp" name="_hp" tabindex="-1" autocomplete="off"><button>Submit</button></form></div>`, ctx.nonce), 200, true);
  });
  r.add('OPTIONS', '/f/:key', { auth: false }, ctx => { ctx.handled = true; ctx.res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }); ctx.res.end(); });
  r.post('/f/:key', { auth: false, rate: 'public' }, ctx => {
    ctx.res.setHeader('Access-Control-Allow-Origin', '*');
    const f = one('SELECT * FROM forms WHERE key=?', ctx.params.key); if (!f) bad('form not found', 404);
    const b = ctx.body, wantsJson = String(ctx.req.headers['content-type'] || '').includes('json');
    const done = () => wantsJson ? { ok: true } : f.redirect_url ? ctx.redirect(f.redirect_url, 303) : ctx.html(page('Thanks', '<div class="card"><h1>Thank you!</h1><p class="mut">We received your details and will be in touch shortly.</p></div>', ctx.nonce), 200, true);
    if (b._hp) return done(); // honeypot: silently drop bots
    const em = U.normEmail(b.email); if (!emailOk(em)) bad('a valid email is required');
    const existing = one('SELECT * FROM contacts WHERE org_id=? AND lower(email)=?', f.org_id, em);
    const owner = existing?.owner_id ?? (f.assign_mode === 'round_robin' ? core.nextAssignee(f.org_id) : f.assign_mode === 'user' ? f.assign_user_id : null);
    const { contact, created } = core.upsertContactByEmail(f.org_id, { name: clean(b.name), email: em, phone: clean(b.phone), title: clean(b.title), company: clean(b.company), source: `form: ${f.name}`, owner_id: owner });
    const custom = {}; for (const [k, v] of Object.entries(b)) if (k.startsWith('custom.') && v !== '') custom[k.slice(7)] = v;
    if (Object.keys(custom).length) { try { run('UPDATE contacts SET custom=? WHERE id=?', core.mergeCustom(f.org_id, 'contacts', custom, contact.custom, true), contact.id); } catch { } }
    const note = Object.entries(b).filter(([k, v]) => k !== '_hp' && v).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${String(v).slice(0, 2000)}`).join('\n');
    insert('activities', { org_id: f.org_id, contact_id: contact.id, type: 'note', subject: `Form submitted: ${f.name}`, note, owner_id: contact.owner_id, done: 1 });
    run('UPDATE forms SET submissions=submissions+1 WHERE id=?', f.id);
    core.scoreContact(contact.id);
    core.notify(f.org_id, contact.owner_id, `New ${created ? 'lead' : 'form submission'}: ${contact.name} (${f.name})`, `#/contacts/${contact.id}`, { email: true });
    const fresh = one('SELECT * FROM contacts WHERE id=?', contact.id);
    if (created) { core.emit(f.org_id, 'contact.created', { contact: fresh }); core.emit(f.org_id, 'lead.created', { contact: fresh, form: { id: f.id, name: f.name } }); }
    if (f.sequence_id) { try { require('../lib/sequences').enroll(f.org_id, f.sequence_id, contact.id, contact.owner_id); } catch { } }
    return done();
  });

  // ---------- meeting booking
  const getPage = slug => { const bp = one('SELECT b.*, u.name user_name, o.name org_name FROM booking_pages b JOIN users u ON u.id=b.user_id JOIN orgs o ON o.id=b.org_id WHERE b.slug=? AND b.active=1 AND u.active=1', slug); if (!bp) bad('booking page not found', 404); return bp; };
  r.get('/book/:slug', { auth: false }, ctx => {
    const bp = getPage(ctx.params.slug);
    ctx.html(page(bp.title, `<div class="card"><p class="mut">${h(bp.org_name)} · ${h(bp.user_name)}</p><h1>${h(bp.title)}</h1><p class="mut">${bp.duration_min} minutes · times shown in your time zone</p>
      <div id="days">Loading…</div><form id="f" hidden><label>Your name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
      <label>Anything we should know?</label><textarea name="note" rows="3"></textarea><input class="hp" name="_hp" tabindex="-1" autocomplete="off"><button>Confirm booking</button><p id="err" style="color:#dc2626"></p></form></div>`, ctx.nonce,
      `const slug=${JSON.stringify(bp.slug)};let pick=null;const D=document.getElementById('days'),F=document.getElementById('f');
      fetch('/book/'+slug+'/slots').then(r=>r.json()).then(days=>{if(!days.length){D.textContent='No times available in the next two weeks.';return}D.innerHTML='';
      for(const d of days){const t=document.createElement('div');t.className='day';t.textContent=new Date(d.slots[0]).toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});D.append(t);
      const w=document.createElement('div');w.className='slots';for(const s of d.slots){const b=document.createElement('button');b.type='button';b.textContent=new Date(s).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
      b.onclick=()=>{document.querySelectorAll('.slots button').forEach(x=>x.classList.remove('on'));b.classList.add('on');pick=s;F.hidden=false};w.append(b)}D.append(w)}});
      F.onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(F));body.start=pick;const r=await fetch('/book/'+slug,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const j=await r.json();if(!r.ok){document.getElementById('err').textContent=j.error;return}document.querySelector('.card').innerHTML='<h1>You are booked ✓</h1><p>'+new Date(pick).toLocaleString(undefined,{dateStyle:'full',timeStyle:'short'})+'</p><p class="mut">A confirmation email is on its way.</p>'}`));
  });
  r.get('/book/:slug/slots', { auth: false }, ctx => slotsFor(getPage(ctx.params.slug)));
  r.post('/book/:slug', { auth: false, rate: 'public' }, ctx => {
    const bp = getPage(ctx.params.slug), b = ctx.body;
    if (b._hp) return { ok: true };
    const em = U.normEmail(b.email); if (!emailOk(em) || !clean(b.name)) bad('name and a valid email are required');
    if (!slotsFor(bp).some(d => d.slots.includes(b.start))) bad('that time is no longer available — please pick another', 409);
    const { contact, created } = core.upsertContactByEmail(bp.org_id, { name: clean(b.name), email: em, source: `booking: ${bp.title}`, owner_id: bp.user_id });
    const start = new Date(b.start), startSql = start.toISOString().replace('T', ' ').slice(0, 19);
    const id = insert('activities', { org_id: bp.org_id, contact_id: contact.id, type: 'meeting', subject: `${bp.title} with ${contact.name}`, note: clean(b.note) || null,
      start_at: startSql, duration_min: bp.duration_min, owner_id: bp.user_id, company_id: contact.company_id });
    const when = start.toLocaleString('en-US', { timeZone: bp.timezone, dateStyle: 'full', timeStyle: 'short' }) + ` (${bp.timezone})`;
    core.notify(bp.org_id, bp.user_id, `Meeting booked: ${contact.name} — ${when}`, `#/contacts/${contact.id}`, { email: true });
    core.enqueue('system_email', { to: em, subject: `Confirmed: ${bp.title} with ${bp.user_name}`, text: `Hi ${U.firstName(contact.name)},\n\nYou're booked for "${bp.title}" with ${bp.user_name} (${bp.org_name}) on ${when}, ${bp.duration_min} minutes.\n\nSee you then!` });
    core.scoreContact(contact.id);
    if (created) core.emit(bp.org_id, 'contact.created', { contact });
    core.emit(bp.org_id, 'meeting.booked', { contact, activity: one('SELECT * FROM activities WHERE id=?', id) });
    return { ok: true };
  });

  // ---------- quotes (public view + e-signature)
  const getQuote = token => { const qt = one('SELECT * FROM quotes WHERE token=?', token); if (!qt) bad('quote not found', 404); return qt; };
  r.get('/q/:token', { auth: false }, ctx => {
    const qt = getQuote(ctx.params.token), org = one('SELECT * FROM orgs WHERE id=?', qt.org_id);
    if (!qt.viewed_at && !ctx.user) {
      run('UPDATE quotes SET viewed_at=CURRENT_TIMESTAMP WHERE id=?', qt.id);
      core.notify(qt.org_id, one('SELECT owner_id FROM deals WHERE id=?', qt.deal_id)?.owner_id, `Quote ${qt.number} was opened by the customer`, `#/deals/${qt.deal_id}`);
    }
    ctx.html(quoteHtml(qt, org, ctx.nonce, ctx.query.get('m') || ''));
  });
  r.post('/q/:token/accept', { auth: false, rate: 'public' }, ctx => {
    const qt = getQuote(ctx.params.token);
    if (['accepted', 'declined'].includes(qt.status)) return ctx.redirect(`/q/${qt.token}`, 303);
    if (qt.valid_until && qt.valid_until < new Date().toISOString().slice(0, 10)) bad('this quote has expired');
    const name = clean(ctx.body.name); if (!name || !ctx.body.agree) bad('type your name and tick the box to accept');
    run("UPDATE quotes SET status='accepted', signed_name=?, signed_at=?, signed_ip=? WHERE id=?", name.slice(0, 120), U.isoNow(), ctx.ip, qt.id);
    const deal = one('SELECT * FROM deals WHERE id=?', qt.deal_id);
    core.audit({ org: { id: qt.org_id }, ip: ctx.ip }, 'quote_accepted', 'deal', deal.id, { quote: qt.number, signed_name: name });
    core.notify(qt.org_id, deal.owner_id, `🎉 Quote ${qt.number} accepted by ${name}`, `#/deals/${deal.id}`, { email: true });
    core.emit(qt.org_id, 'quote.accepted', { deal, quote: one('SELECT id, number, title, signed_name FROM quotes WHERE id=?', qt.id) });
    ctx.redirect(`/q/${qt.token}?m=${encodeURIComponent('Thank you — the quote has been accepted.')}`, 303);
  });
  r.post('/q/:token/decline', { auth: false, rate: 'public' }, ctx => {
    const qt = getQuote(ctx.params.token); if (['accepted', 'declined'].includes(qt.status)) return ctx.redirect(`/q/${qt.token}`, 303);
    run("UPDATE quotes SET status='declined' WHERE id=?", qt.id);
    core.notify(qt.org_id, one('SELECT owner_id FROM deals WHERE id=?', qt.deal_id)?.owner_id, `Quote ${qt.number} was declined`, `#/deals/${qt.deal_id}`);
    ctx.redirect(`/q/${qt.token}`, 303);
  });

  // ---------- email open tracking + unsubscribe
  r.get('/t/:file', { auth: false }, ctx => {
    const token = ctx.params.file.replace(/\.gif$/, ''), e = one('SELECT * FROM emails WHERE track_token=?', token);
    if (e) {
      run('UPDATE emails SET open_count=open_count+1, opened_at=COALESCE(opened_at, CURRENT_TIMESTAMP) WHERE id=?', e.id);
      if (e.contact_id) {
        core.scoreContact(e.contact_id);
        if (!e.open_count) { const c = one('SELECT name FROM contacts WHERE id=?', e.contact_id); core.notify(e.org_id, e.user_id, `${c?.name || 'Contact'} opened "${e.subject}"`, `#/contacts/${e.contact_id}`); core.emit(e.org_id, 'email.opened', { email: { id: e.id, subject: e.subject }, contact: one('SELECT * FROM contacts WHERE id=?', e.contact_id) }); }
      }
    }
    ctx.send(PIXEL, 'image/gif', { 'Cache-Control': 'no-store, max-age=0' });
  });
  r.get('/u/:token', { auth: false }, ctx => {
    const e = one('SELECT * FROM emails WHERE track_token=?', ctx.params.token); if (!e) bad('link not found', 404);
    ctx.html(page('Unsubscribe', `<div class="card"><h1>Unsubscribe</h1><p class="mut">Stop receiving these emails at ${h(e.to_addr)}?</p><form method="post"><button>Unsubscribe</button></form></div>`, ctx.nonce));
  });
  r.post('/u/:token', { auth: false, rate: 'public' }, ctx => {
    const e = one('SELECT * FROM emails WHERE track_token=?', ctx.params.token); if (!e) bad('link not found', 404);
    if (e.contact_id) { run('UPDATE contacts SET unsubscribed=1 WHERE id=?', e.contact_id); run("UPDATE enrollments SET status='unsubscribed' WHERE contact_id=? AND status='active'", e.contact_id); }
    ctx.html(page('Unsubscribed', '<div class="card"><h1>You are unsubscribed</h1><p class="mut">You will not receive further emails from this sequence.</p></div>', ctx.nonce));
  });

  // ---------- calendar feed (subscribe in Google/Outlook/Apple Calendar)
  r.get('/cal/:file', { auth: false }, ctx => {
    const u = one('SELECT * FROM users WHERE calendar_token=? AND active=1', ctx.params.file.replace(/\.ics$/, '')); if (!u) bad('not found', 404);
    const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    const fold = l => l.match(/.{1,73}/g).join('\r\n ');
    const stamp = t => t.replace(/[-:]/g, '').replace(' ', 'T').slice(0, 15) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PipelineHQ//CRM//EN', 'X-WR-CALNAME:PipelineHQ', 'CALSCALE:GREGORIAN'];
    for (const a of q(`SELECT a.*, c.name contact_name FROM activities a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.owner_id=? AND (a.start_at IS NOT NULL OR a.due_date IS NOT NULL)
        AND COALESCE(a.start_at, a.due_date) >= date('now','-60 days') ORDER BY a.id DESC LIMIT 1000`, u.id)) {
      lines.push('BEGIN:VEVENT', `UID:act-${a.id}@pipelinehq`, `DTSTAMP:${stamp(a.created_at)}`);
      if (a.start_at) { const end = new Date(new Date(a.start_at.replace(' ', 'T') + 'Z').getTime() + (a.duration_min || 30) * 60e3).toISOString(); lines.push(`DTSTART:${stamp(a.start_at)}`, `DTEND:${stamp(end.replace('T', ' '))}`); }
      else { const d = a.due_date.replace(/-/g, ''); const n = new Date(new Date(a.due_date).getTime() + 864e5).toISOString().slice(0, 10).replace(/-/g, ''); lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${n}`); }
      lines.push(fold(`SUMMARY:${esc((a.done ? '✓ ' : '') + (a.subject || `${a.type}: ${a.note || ''}`.slice(0, 120)))}`), fold(`DESCRIPTION:${esc([a.note, a.contact_name && 'Contact: ' + a.contact_name].filter(Boolean).join('\n'))}`), 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    ctx.send(lines.join('\r\n'), 'text/calendar; charset=utf-8', { 'Cache-Control': 'no-store' });
  });

  // ---------- inbound email (Postmark/Mailgun-style JSON or form) → logs to the matching contact's timeline
  r.post('/api/inbound/:token', { auth: false }, ctx => {
    const org = one('SELECT id FROM orgs WHERE inbound_token=?', ctx.params.token); if (!org) bad('not found', 404);
    const b = ctx.body, pick = (...k) => k.map(x => b[x]).find(v => v != null && v !== '');
    const addrs = s => (String(s || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).map(a => a.toLowerCase());
    const fromRaw = pick('From', 'from', 'sender') || b.FromFull?.Email;
    const to = [...addrs(pick('To', 'to', 'recipient')), ...addrs(pick('Cc', 'cc')), ...addrs(pick('Bcc', 'bcc'))].filter(a => !a.startsWith('log+'));
    const id = require('../lib/inbound').record(org.id, { from: addrs(fromRaw)[0], to, subject: pick('Subject', 'subject'), text: pick('TextBody', 'stripped-text', 'body-plain', 'text', 'body'),
      messageId: pick('MessageID', 'Message-Id', 'message_id') || null });
    return { logged: !!id };
  });

  // ---------- Stripe webhook
  r.post('/api/billing/webhook', { auth: false, raw: true }, ctx => {
    const raw = ctx.rawBody.toString('utf8');
    if (!require('../lib/stripe').verify(raw, ctx.req.headers['stripe-signature'])) bad('invalid signature', 400);
    require('../lib/stripe').handleEvent(JSON.parse(raw));
    return { received: true };
  });
};
module.exports.slotsFor = slotsFor;
