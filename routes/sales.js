// Sales features: dashboard, pipelines/stages, custom fields, saved views, email + templates + sequences, lead forms + scoring,
// booking pages, products/price books/quotes, quotas/forecast, reports, workflows, notifications, AI assistant, click-to-call.
const { q, one, run, insert, tx } = require('../lib/db');
const U = require('../lib/util');
const { bad, clean, json, randomToken } = U;
const core = require('../lib/core');
const { crud } = require('../lib/crud');
const { limits, requireFeature } = require('../lib/plans');
const email = require('../lib/email');
const seq = require('../lib/sequences');
const wf = require('../lib/workflows');
const ai = require('../lib/ai');

const ADMIN = ['owner', 'admin'], MGMT = ['owner', 'admin', 'manager'];
const month = (d = new Date()) => d.toISOString().slice(0, 7);
function inScope(ctx, col) { return core.scopeSql(ctx.user, col); }

function quoteTotals(quoteId) {
  const qt = one('SELECT * FROM quotes WHERE id=?', quoteId); const items = q('SELECT * FROM quote_items WHERE quote_id=? ORDER BY position, id', quoteId);
  const lines = items.map(i => ({ ...i, total: +(i.qty * i.unit_price * (1 - i.discount_pct / 100)).toFixed(2) }));
  const subtotal = +lines.reduce((s, l) => s + l.total, 0).toFixed(2), discount = +(subtotal * qt.discount_pct / 100).toFixed(2);
  const tax = +((subtotal - discount) * qt.tax_pct / 100).toFixed(2);
  return { items: lines, subtotal, discount, tax, total: +(subtotal - discount + tax).toFixed(2) };
}

function recentText(orgId, where) {
  return core.timeline(orgId, where).slice(0, 25).map(t => t.kind === 'email' ? `[${t.at}] email ${t.direction === 'in' ? 'from' : 'to'} contact: "${t.subject}" — ${String(t.body || '').slice(0, 300)}`
    : t.kind === 'activity' ? `[${t.at}] ${t.type}${t.done ? ' (done)' : ''}: ${t.subject || ''} ${String(t.note || '').slice(0, 300)}${t.outcome ? ' — outcome: ' + t.outcome : ''}`
      : t.kind === 'stage' ? `[${t.at}] stage ${t.from_name || 'new'} → ${t.to_name}` : `[${t.at}] ${t.action}`).join('\n');
}

module.exports = function (r) {
  // ---------------- dashboard
  r.get('/api/dashboard', ctx => {
    const o = ctx.org.id, s = inScope(ctx, 'd.owner_id'), today = new Date().toISOString().slice(0, 10);
    const pid = Number(ctx.query.get('pipeline_id')) || one('SELECT id FROM pipelines WHERE org_id=? ORDER BY position, id', o)?.id;
    const base = `FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=?${s.sql}`;
    const open = one(`SELECT COUNT(*) n, COALESCE(SUM(d.value),0) v, COALESCE(SUM(d.value*st.probability/100.0),0) w ${base} AND st.kind='open'`, o, ...s.args);
    const wonMonth = one(`SELECT COUNT(*) n, COALESCE(SUM(d.value),0) v ${base} AND st.kind='won' AND substr(d.closed_at,1,7)=?`, o, ...s.args, month());
    const closed90 = one(`SELECT SUM(st.kind='won') won, SUM(st.kind='lost') lost ${base} AND st.kind<>'open' AND d.closed_at>=datetime('now','-90 days')`, o, ...s.args);
    const cs = inScope(ctx, 'c.owner_id');
    const newLeads = one(`SELECT COUNT(*) n FROM contacts c WHERE c.org_id=? AND c.lifecycle='lead' AND c.created_at>=datetime('now','-7 days')${cs.sql}`, o, ...cs.args).n;
    const byStage = q(`SELECT st.id, st.name, st.kind, COUNT(d.id) n, COALESCE(SUM(d.value),0) total FROM stages st LEFT JOIN deals d ON d.stage_id=st.id${s.sql.replace(/d\.owner_id/g, 'd.owner_id')}
      WHERE st.pipeline_id=? GROUP BY st.id ORDER BY st.position`, ...s.args, pid);
    const tasks = q(`SELECT a.*, d.title deal_title, c.name contact_name FROM activities a LEFT JOIN deals d ON d.id=a.deal_id LEFT JOIN contacts c ON c.id=a.contact_id
      WHERE a.org_id=? AND a.owner_id=? AND a.done=0 AND (a.due_date<=? OR date(a.start_at)=?) ORDER BY a.due_date, a.start_at LIMIT 12`, o, ctx.user.id, today, today);
    const meetings = q(`SELECT a.*, c.name contact_name FROM activities a LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.org_id=? AND a.owner_id=? AND a.type='meeting' AND a.done=0
      AND a.start_at>=? ORDER BY a.start_at LIMIT 5`, o, ctx.user.id, U.isoNow());
    const closing = q(`SELECT d.id, d.title, d.value, d.close_date, st.name stage_name ${base} AND st.kind='open' AND d.close_date IS NOT NULL ORDER BY d.close_date LIMIT 6`, o, ...s.args);
    const feed = q(`SELECT a.action, a.entity, a.entity_id, a.at, a.detail, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.org_id=? AND a.entity IN ('deal','contact','company')
      ${core.visibleUserIds(ctx.user) ? `AND a.user_id IN (${core.visibleUserIds(ctx.user).join(',')})` : ''} ORDER BY a.id DESC LIMIT 12`, o).map(f => { const detail = json(f.detail, {}), t = { deal: ['deals', 'title'], contact: ['contacts', 'name'], company: ['companies', 'name'] }[f.entity];
      return { ...f, detail, name: (f.entity_id && one(`SELECT ${t[1]} n FROM ${t[0]} WHERE id=? AND org_id=?`, f.entity_id, o)?.n) || detail.name || null }; });
    const quota = one('SELECT amount FROM quotas WHERE org_id=? AND user_id=? AND period=?', o, ctx.user.id, month())?.amount ?? null;
    const myWon = one(`SELECT COALESCE(SUM(d.value),0) v FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.owner_id=? AND st.kind='won' AND substr(d.closed_at,1,7)=?`, o, ctx.user.id, month()).v;
    return { open, wonMonth, winRate: closed90.won + closed90.lost ? Math.round(100 * closed90.won / (closed90.won + closed90.lost)) : null, newLeads, byStage, pipeline_id: pid, tasks, meetings, closing, feed, quota, myWon };
  });

  // ---------------- pipelines & stages
  r.get('/api/pipelines', ctx => q('SELECT * FROM pipelines WHERE org_id=? ORDER BY position, id', ctx.org.id).map(p => ({ ...p, stages: q('SELECT * FROM stages WHERE pipeline_id=? ORDER BY position', p.id) })));
  r.post('/api/pipelines', { roles: ADMIN }, ctx => {
    const lim = limits(ctx.org).pipelines;
    if (lim != null && one('SELECT COUNT(*) n FROM pipelines WHERE org_id=?', ctx.org.id).n >= lim) bad('Multiple pipelines need the Pro plan', 402);
    if (!clean(ctx.body.name)) bad('name is required');
    const id = require('./auth').seedPipeline(ctx.org.id, clean(ctx.body.name));
    core.audit(ctx, 'create', 'pipeline', id, { name: ctx.body.name }); return { id };
  });
  r.patch('/api/pipelines/:id', { roles: ADMIN }, ctx => { if (!clean(ctx.body.name)) bad('name is required'); run('UPDATE pipelines SET name=? WHERE id=? AND org_id=?', clean(ctx.body.name), Number(ctx.params.id), ctx.org.id); });
  r.del('/api/pipelines/:id', { roles: ADMIN }, ctx => {
    const id = Number(ctx.params.id);
    if (one('SELECT COUNT(*) n FROM pipelines WHERE org_id=?', ctx.org.id).n <= 1) bad('you need at least one pipeline');
    if (one('SELECT 1 FROM deals WHERE pipeline_id=? AND org_id=?', id, ctx.org.id)) bad('move or delete the deals in this pipeline first', 409);
    run('DELETE FROM pipelines WHERE id=? AND org_id=?', id, ctx.org.id); core.audit(ctx, 'delete', 'pipeline', id);
  });
  // Replace a pipeline's stage list (create/rename/reorder/delete).
  r.put('/api/pipelines/:id/stages', { roles: ADMIN }, ctx => {
    const p = one('SELECT * FROM pipelines WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!p) bad('not found', 404);
    const list = ctx.body.stages; if (!Array.isArray(list) || list.length < 2) bad('a pipeline needs at least 2 stages');
    if (!list.some(s => s.kind === 'won') || !list.some(s => s.kind === 'lost')) bad('include at least one Won and one Lost stage');
    tx(() => {
      const keep = new Set();
      list.forEach((s, i) => {
        if (!clean(s.name) || !['open', 'won', 'lost'].includes(s.kind)) bad('each stage needs a name and kind (open/won/lost)');
        const prob = Math.max(0, Math.min(100, Number(s.probability) || 0));
        if (s.id && one('SELECT 1 FROM stages WHERE id=? AND pipeline_id=?', Number(s.id), p.id)) { run('UPDATE stages SET name=?, probability=?, kind=?, position=? WHERE id=?', clean(s.name), prob, s.kind, i, Number(s.id)); keep.add(Number(s.id)); }
        else keep.add(insert('stages', { org_id: ctx.org.id, pipeline_id: p.id, name: clean(s.name), probability: prob, kind: s.kind, position: i }));
      });
      for (const s of q('SELECT id, name FROM stages WHERE pipeline_id=?', p.id)) if (!keep.has(s.id)) {
        if (one('SELECT 1 FROM deals WHERE stage_id=?', s.id)) bad(`Stage "${s.name}" still has deals — move them before removing it`, 409);
        run('DELETE FROM stages WHERE id=?', s.id);
      }
    });
    core.audit(ctx, 'update', 'pipeline', p.id, { stages: list.map(s => s.name) });
    return q('SELECT * FROM stages WHERE pipeline_id=? ORDER BY position', p.id);
  });

  // ---------------- custom fields, saved views
  crud(r, '/api/fields', 'field_defs', { cols: ['entity', 'key', 'label', 'type', 'options', 'required', 'position'], req: ['entity', 'label', 'type'], json: ['options'], bool: ['required'], num: ['position'],
    roles: ADMIN, feature: 'custom_fields', list: 'SELECT * FROM field_defs WHERE org_id=? ORDER BY entity, position, id',
    validate(o, ctx, ex) {
      if (ex && 'key' in o && o.key !== ex.key) bad('the key of a field cannot be changed');
      if (ex && 'entity' in o && o.entity !== ex.entity) bad('the record type of a field cannot be changed');
      if (!ex) { if (!['contacts', 'companies', 'deals'].includes(o.entity)) bad('entity must be contacts, companies or deals'); o.key = (o.key || o.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40); if (!o.key) bad('invalid key'); }
      if ('type' in o && !core.FIELD_TYPES.includes(o.type)) bad('invalid field type');
      if ((o.type || ex?.type) === 'select' && !json(o.options ?? ex?.options, []).length) bad('select fields need options');
    } });
  r.get('/api/views', ctx => q('SELECT * FROM views WHERE org_id=? AND (user_id=? OR shared=1) ORDER BY name', ctx.org.id, ctx.user.id));
  r.post('/api/views', ctx => {
    const { entity, name, query: qs, shared } = ctx.body;
    if (!['contacts', 'companies', 'deals', 'activities'].includes(entity) || !clean(name)) bad('entity and name required');
    return { id: insert('views', { org_id: ctx.org.id, user_id: ctx.user.id, entity, name: clean(name).slice(0, 100), query: String(qs || '').slice(0, 2000), shared: shared ? 1 : 0 }) };
  });
  r.del('/api/views/:id', ctx => { run('DELETE FROM views WHERE id=? AND org_id=? AND (user_id=? OR ?)', Number(ctx.params.id), ctx.org.id, ctx.user.id, ADMIN.includes(ctx.user.role) ? 1 : 0); });

  // ---------------- email: templates, compose, outbox, tracking stats
  crud(r, '/api/templates', 'email_templates', { cols: ['name', 'subject', 'body'], req: ['name', 'subject', 'body'], list: 'SELECT * FROM email_templates WHERE org_id=? ORDER BY name' });
  r.post('/api/emails/send', ctx => {
    const c = core.getRecord(ctx, 'contacts', ctx.body.contact_id);
    const deal = ctx.body.deal_id ? core.getRecord(ctx, 'deals', ctx.body.deal_id) : null;
    let { subject, body } = ctx.body;
    if (ctx.body.template_id) {
      const t = one('SELECT * FROM email_templates WHERE id=? AND org_id=?', Number(ctx.body.template_id), ctx.org.id); if (!t) bad('template not found');
      const me = one('SELECT * FROM users WHERE id=?', ctx.user.id);
      ({ subject, body } = email.renderTemplate({ subject: subject || t.subject, body: body || t.body }, email.mergeContext(c, deal, me)));
    }
    if (!clean(subject) || !clean(body)) bad('subject and body are required');
    const id = email.queueEmail({ orgId: ctx.org.id, user: one('SELECT * FROM users WHERE id=?', ctx.user.id), contact: c, dealId: deal?.id, subject: clean(subject), body: String(body) });
    core.audit(ctx, 'email', 'contact', c.id, { subject });
    setImmediate(() => require('../lib/worker').runJobs().catch(() => { }));
    return { id };
  });
  r.get('/api/emails', ctx => {
    const s = core.visibleUserIds(ctx.user); const args = [ctx.org.id]; let sql = `SELECT e.id, e.direction, e.subject, e.status, e.error, e.to_addr, e.from_addr, e.open_count, e.opened_at, e.sent_at, e.created_at,
      e.contact_id, c.name contact_name, u.name user_name FROM emails e LEFT JOIN contacts c ON c.id=e.contact_id LEFT JOIN users u ON u.id=e.user_id WHERE e.org_id=?`;
    if (s) { sql += ` AND (e.user_id IN (${s.join(',')}) OR c.owner_id IN (${s.join(',')}))`; }
    if (ctx.query.get('status')) { sql += ' AND e.status=?'; args.push(ctx.query.get('status')); }
    if (ctx.query.get('direction')) { sql += ' AND e.direction=?'; args.push(ctx.query.get('direction')); }
    return q(sql + ' ORDER BY e.id DESC LIMIT 300', ...args);
  });
  r.get('/api/emails/:id', ctx => { const e = one('SELECT * FROM emails WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!e) bad('not found', 404); if (e.contact_id) core.getRecord(ctx, 'contacts', e.contact_id); return e; });

  // ---------------- sequences
  crud(r, '/api/sequences', 'sequences', { cols: ['name', 'steps', 'active'], req: ['name', 'steps'], json: ['steps'], bool: ['active'], feature: 'sequences',
    list: `SELECT s.*, (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id=s.id AND e.status='active') active_count, (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id=s.id) total_count,
      (SELECT COUNT(*) FROM enrollments e WHERE e.sequence_id=s.id AND e.status='replied') replied_count FROM sequences s WHERE s.org_id=? ORDER BY s.name`,
    validate(o, ctx) {
      if ('steps' in o) { const steps = seq.validateSteps(JSON.parse(o.steps)); for (const s of steps) if (s.template_id && !one('SELECT 1 FROM email_templates WHERE id=? AND org_id=?', s.template_id, ctx.org.id)) bad('invalid template in steps'); o.steps = JSON.stringify(steps); }
    } });
  r.post('/api/sequences/:id/enroll', { feature: 'sequences' }, ctx => {
    const ids = (ctx.body.contact_ids || []).map(Number); if (!ids.length) bad('choose contacts');
    const res = { enrolled: 0, errors: [] };
    for (const cid of ids) { try { core.getRecord(ctx, 'contacts', cid); seq.enroll(ctx.org.id, Number(ctx.params.id), cid, ctx.user.id, ctx.body.deal_id ? core.getRecord(ctx, 'deals', ctx.body.deal_id).id : null); res.enrolled++; } catch (e) { res.errors.push({ contact_id: cid, error: e.message }); } }
    setImmediate(() => require('../lib/worker').tick().catch(() => { }));
    return res;
  });
  r.get('/api/sequences/:id/enrollments', { feature: 'sequences' }, ctx => q(`SELECT e.*, c.name contact_name, c.email contact_email FROM enrollments e JOIN contacts c ON c.id=e.contact_id
    WHERE e.sequence_id=? AND e.org_id=? ORDER BY e.id DESC LIMIT 500`, Number(ctx.params.id), ctx.org.id));
  r.post('/api/enrollments/:id/stop', ctx => { run("UPDATE enrollments SET status='stopped' WHERE id=? AND org_id=? AND status='active'", Number(ctx.params.id), ctx.org.id); });

  // ---------------- lead capture: forms + scoring
  crud(r, '/api/forms', 'forms', { cols: ['name', 'fields', 'assign_mode', 'assign_user_id', 'redirect_url', 'sequence_id'], req: ['name'], json: ['fields'], num: ['assign_user_id', 'sequence_id'],
    feature: 'forms', roles: MGMT, defaults: () => ({ key: randomToken(9) }),
    validate(o, ctx) {
      if ('assign_mode' in o && !['round_robin', 'user', 'none'].includes(o.assign_mode)) bad('invalid assignment mode');
      if (o.assign_user_id && !one('SELECT 1 FROM users WHERE id=? AND org_id=?', o.assign_user_id, ctx.org.id)) bad('invalid user');
      if (o.sequence_id && !one('SELECT 1 FROM sequences WHERE id=? AND org_id=?', o.sequence_id, ctx.org.id)) bad('invalid sequence');
      if (o.redirect_url && !/^https?:\/\//.test(o.redirect_url)) bad('redirect URL must start with http(s)://');
      if ('fields' in o) { const f = JSON.parse(o.fields); if (!Array.isArray(f) || !f.includes('email')) bad('forms must include the email field'); }
    } });
  crud(r, '/api/scoring', 'scoring_rules', { cols: ['field', 'op', 'value', 'points'], req: ['field', 'op', 'points'], num: ['points'], roles: MGMT,
    validate(o) { if ('op' in o && !['contains', 'eq', 'neq', 'gt', 'lt', 'not_empty', 'empty', 'business_email'].includes(o.op)) bad('invalid operator'); } });
  r.post('/api/scoring/recalculate', { roles: MGMT }, ctx => { const ids = q('SELECT id FROM contacts WHERE org_id=?', ctx.org.id); for (const c of ids) core.scoreContact(c.id); return { updated: ids.length }; });

  // ---------------- booking pages (meeting scheduler)
  crud(r, '/api/booking-pages', 'booking_pages', { cols: ['user_id', 'slug', 'title', 'duration_min', 'days', 'start_hour', 'end_hour', 'timezone', 'active'], req: ['slug', 'title'],
    num: ['user_id', 'duration_min', 'start_hour', 'end_hour'], bool: ['active'], feature: 'booking', defaults: ctx => ({ user_id: ctx.user.id, timezone: ctx.org.timezone }),
    list: 'SELECT b.*, u.name user_name FROM booking_pages b JOIN users u ON u.id=b.user_id WHERE b.org_id=? ORDER BY b.id',
    validate(o, ctx, ex) {
      if ('slug' in o) { o.slug = String(o.slug).toLowerCase(); if (!/^[a-z0-9-]{3,40}$/.test(o.slug)) bad('link name: 3–40 lowercase letters, numbers or dashes'); if (one('SELECT 1 FROM booking_pages WHERE slug=? AND id<>?', o.slug, ex?.id || 0)) bad('that link name is taken', 409); }
      if (o.user_id && o.user_id !== ctx.user.id && !MGMT.includes(ctx.user.role)) bad('you can only create booking pages for yourself', 403);
      if (o.user_id && !one('SELECT 1 FROM users WHERE id=? AND org_id=?', o.user_id, ctx.org.id)) bad('invalid user');
      if ('timezone' in o && !U.validTz(o.timezone)) bad('invalid time zone');
      if ('duration_min' in o && !(o.duration_min >= 10 && o.duration_min <= 240)) bad('duration must be 10–240 minutes');
      const sh = o.start_hour ?? ex?.start_hour ?? 9, eh = o.end_hour ?? ex?.end_hour ?? 17; if (!(sh >= 0 && eh <= 24 && sh < eh)) bad('invalid hours');
      if ('days' in o && !/^[0-6](,[0-6])*$/.test(o.days)) bad('days must be like 1,2,3,4,5 (0=Sunday)');
    } });

  // ---------------- products, price books, quotes
  crud(r, '/api/products', 'products', { cols: ['name', 'sku', 'price', 'description', 'active'], req: ['name'], num: ['price'], bool: ['active'], roles: MGMT, list: 'SELECT * FROM products WHERE org_id=? ORDER BY name' });
  crud(r, '/api/price-books', 'price_books', { cols: ['name'], req: ['name'], roles: MGMT, list: 'SELECT * FROM price_books WHERE org_id=? ORDER BY name' });
  r.get('/api/price-books/:id/entries', ctx => {
    const pb = one('SELECT * FROM price_books WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!pb) bad('not found', 404);
    return q('SELECT p.id product_id, p.name, p.sku, p.price list_price, e.price FROM products p LEFT JOIN price_book_entries e ON e.product_id=p.id AND e.price_book_id=? WHERE p.org_id=? ORDER BY p.name', pb.id, ctx.org.id);
  });
  r.put('/api/price-books/:id/entries', { roles: MGMT }, ctx => {
    const pb = one('SELECT * FROM price_books WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!pb) bad('not found', 404);
    tx(() => {
      run('DELETE FROM price_book_entries WHERE price_book_id=?', pb.id);
      for (const e of ctx.body.entries || []) if (e.price !== '' && e.price != null && one('SELECT 1 FROM products WHERE id=? AND org_id=?', Number(e.product_id), ctx.org.id))
        insert('price_book_entries', { price_book_id: pb.id, product_id: Number(e.product_id), price: Number(e.price) || 0 });
    });
  });

  const quoteOut = (ctx, id) => { const qt = one('SELECT * FROM quotes WHERE id=? AND org_id=?', Number(id), ctx.org.id); if (!qt) bad('not found', 404); core.getRecord(ctx, 'deals', qt.deal_id); return { ...qt, ...quoteTotals(qt.id), deal: one('SELECT id, title, contact_id FROM deals WHERE id=?', qt.deal_id), public_url: `${email.APP_URL()}/q/${qt.token}` }; };
  r.get('/api/quotes', { feature: 'quotes' }, ctx => {
    const s = inScope(ctx, 'd.owner_id');
    return q(`SELECT qt.*, d.title deal_title FROM quotes qt JOIN deals d ON d.id=qt.deal_id WHERE qt.org_id=?${s.sql} ORDER BY qt.id DESC LIMIT 500`, ctx.org.id, ...s.args).map(x => ({ ...x, total: quoteTotals(x.id).total }));
  });
  r.get('/api/quotes/:id', { feature: 'quotes' }, ctx => quoteOut(ctx, ctx.params.id));
  r.post('/api/quotes', { feature: 'quotes' }, ctx => {
    const deal = core.getRecord(ctx, 'deals', ctx.body.deal_id);
    const n = one('SELECT COUNT(*) n FROM quotes WHERE org_id=?', ctx.org.id).n + 1;
    const pb = ctx.body.price_book_id ? one('SELECT id FROM price_books WHERE id=? AND org_id=?', Number(ctx.body.price_book_id), ctx.org.id)?.id : null;
    const id = insert('quotes', { org_id: ctx.org.id, deal_id: deal.id, number: `Q-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`, title: clean(ctx.body.title) || deal.title,
      price_book_id: pb, token: randomToken(24), created_by: ctx.user.id, valid_until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) });
    core.audit(ctx, 'create', 'quote', id, { deal: deal.id });
    return quoteOut(ctx, id);
  });
  r.patch('/api/quotes/:id', { feature: 'quotes' }, ctx => {
    const qt = quoteOut(ctx, ctx.params.id); if (['accepted'].includes(qt.status)) bad('accepted quotes cannot be edited');
    const b = ctx.body, o = {};
    for (const k of ['title', 'notes']) if (k in b) o[k] = clean(b[k]) || null;
    for (const k of ['discount_pct', 'tax_pct']) if (k in b) { const v = Number(b[k]) || 0; if (v < 0 || v > 100) bad(`${k} must be 0–100`); o[k] = v; }
    if ('valid_until' in b) o.valid_until = b.valid_until || null;
    if ('status' in b) { if (!['draft', 'sent', 'declined'].includes(b.status)) bad('invalid status'); o.status = b.status; }
    if (Object.keys(o).length) run(`UPDATE quotes SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(o), qt.id);
    return quoteOut(ctx, qt.id);
  });
  r.put('/api/quotes/:id/items', { feature: 'quotes' }, ctx => {
    const qt = quoteOut(ctx, ctx.params.id); if (qt.status === 'accepted') bad('accepted quotes cannot be edited');
    const items = ctx.body.items; if (!Array.isArray(items) || items.length > 200) bad('items must be a list');
    tx(() => {
      run('DELETE FROM quote_items WHERE quote_id=?', qt.id);
      items.forEach((it, i) => {
        let name = clean(it.name), price = Number(it.unit_price);
        const p = it.product_id ? one('SELECT * FROM products WHERE id=? AND org_id=?', Number(it.product_id), ctx.org.id) : null;
        if (p) { name ||= p.name; if (!Number.isFinite(price) || it.unit_price === '' || it.unit_price == null) price = (qt.price_book_id && one('SELECT price FROM price_book_entries WHERE price_book_id=? AND product_id=?', qt.price_book_id, p.id)?.price) ?? p.price; }
        if (!name) bad(`line ${i + 1} needs a name or product`);
        insert('quote_items', { org_id: ctx.org.id, quote_id: qt.id, product_id: p?.id ?? null, name, qty: Number(it.qty) || 1, unit_price: Number.isFinite(price) ? price : 0, discount_pct: Math.min(100, Math.max(0, Number(it.discount_pct) || 0)), position: i });
      });
    });
    return quoteOut(ctx, qt.id);
  });
  r.post('/api/quotes/:id/send', { feature: 'quotes' }, ctx => {
    const qt = quoteOut(ctx, ctx.params.id), deal = one('SELECT * FROM deals WHERE id=?', qt.deal_id);
    const contact = deal.contact_id && one('SELECT * FROM contacts WHERE id=?', deal.contact_id); if (!contact?.email) bad('the deal needs a contact with an email address');
    if (!qt.items.length) bad('add at least one line item first');
    const me = one('SELECT * FROM users WHERE id=?', ctx.user.id);
    email.queueEmail({ orgId: ctx.org.id, user: me, contact, dealId: deal.id, subject: ctx.body.subject || `Quote ${qt.number}: ${qt.title}`,
      body: ctx.body.body || `Hi ${U.firstName(contact.name)},\n\nHere is your quote ${qt.number} for ${qt.title}. You can review and accept it online:\n${qt.public_url}\n\nBest,\n${me.name}` });
    run("UPDATE quotes SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=? AND status<>'accepted'", qt.id);
    core.audit(ctx, 'send', 'quote', qt.id);
    setImmediate(() => require('../lib/worker').runJobs().catch(() => { }));
    return quoteOut(ctx, qt.id);
  });
  r.del('/api/quotes/:id', { feature: 'quotes' }, ctx => { const qt = quoteOut(ctx, ctx.params.id); run('DELETE FROM quotes WHERE id=?', qt.id); core.audit(ctx, 'delete', 'quote', qt.id); });

  // ---------------- quotas & forecast
  r.get('/api/quotas', ctx => q('SELECT * FROM quotas WHERE org_id=? AND period=?', ctx.org.id, ctx.query.get('period') || month()));
  r.put('/api/quotas', { roles: MGMT }, ctx => {
    const { user_id, period, amount } = ctx.body;
    if (!/^\d{4}-\d{2}$/.test(period || '')) bad('period must be YYYY-MM');
    const uid = one('SELECT id FROM users WHERE id=? AND org_id=?', Number(user_id), ctx.org.id)?.id; if (!uid || !core.canSee(ctx.user, uid)) bad('invalid user');
    if (amount === '' || amount == null) run('DELETE FROM quotas WHERE org_id=? AND user_id=? AND period=?', ctx.org.id, uid, period);
    else run('INSERT INTO quotas VALUES(?,?,?,?) ON CONFLICT(org_id,user_id,period) DO UPDATE SET amount=excluded.amount', ctx.org.id, uid, period, Math.max(0, Number(amount) || 0));
  });
  r.get('/api/forecast', { feature: 'forecast' }, ctx => {
    const o = ctx.org.id, s = inScope(ctx, 'd.owner_id'), n = Math.min(Number(ctx.query.get('months')) || 6, 12);
    const pid = ctx.query.get('pipeline_id'); const pf = pid ? ' AND d.pipeline_id=' + Number(pid) : '';
    const months = []; const d0 = new Date(); d0.setUTCDate(1);
    for (let i = 0; i < n; i++) { const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1)); months.push(month(d)); }
    const base = `FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=?${s.sql}${pf}`;
    const series = months.map(m => {
      const won = one(`SELECT COALESCE(SUM(d.value),0) v ${base} AND st.kind='won' AND substr(d.closed_at,1,7)=?`, o, ...s.args, m).v;
      const open = one(`SELECT COALESCE(SUM(d.value),0) best, COALESCE(SUM(d.value*st.probability/100.0),0) weighted, COALESCE(SUM(CASE WHEN st.probability>=75 THEN d.value END),0) commit_v, COUNT(*) n
        ${base} AND st.kind='open' AND substr(d.close_date,1,7)=?`, o, ...s.args, m);
      const quota = one(`SELECT COALESCE(SUM(amount),0) v FROM quotas WHERE org_id=? AND period=?${s.sql.replace(/d\.owner_id/g, 'user_id').replace(/user_id IS NULL OR /, '')}`, o, m, ...s.args).v;
      return { month: m, won, commit: won + open.commit_v, weighted: won + open.weighted, best: won + open.best, open_deals: open.n, quota };
    });
    const period = ctx.query.get('period') || month();
    const reps = q(`SELECT id, name FROM users WHERE org_id=? AND active=1 ORDER BY name`, o).filter(u => core.canSee(ctx.user, u.id)).map(u => {
      const won = one(`SELECT COALESCE(SUM(d.value),0) v FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.owner_id=? AND st.kind='won' AND substr(d.closed_at,1,7)=?${pf}`, o, u.id, period).v;
      const op = one(`SELECT COALESCE(SUM(d.value*st.probability/100.0),0) w, COALESCE(SUM(d.value),0) v FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.owner_id=? AND st.kind='open' AND substr(d.close_date,1,7)=?${pf}`, o, u.id, period);
      const quota = one('SELECT amount FROM quotas WHERE org_id=? AND user_id=? AND period=?', o, u.id, period)?.amount ?? null;
      return { user_id: u.id, name: u.name, won, weighted: won + op.w, pipeline: op.v, quota, attainment: quota ? Math.round(100 * won / quota) : null };
    });
    const undated = one(`SELECT COUNT(*) n, COALESCE(SUM(d.value),0) v ${base} AND st.kind='open' AND d.close_date IS NULL`, o, ...s.args);
    const overdue = one(`SELECT COUNT(*) n, COALESCE(SUM(d.value),0) v ${base} AND st.kind='open' AND d.close_date < ?`, o, ...s.args, new Date().toISOString().slice(0, 10));
    return { series, period, reps, undated, overdue };
  });

  // ---------------- reports
  r.get('/api/reports', ctx => {
    const o = ctx.org.id, s = inScope(ctx, 'd.owner_id');
    const from = ctx.query.get('from') || new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), to = (ctx.query.get('to') || new Date().toISOString().slice(0, 10)) + ' 99';
    const pid = Number(ctx.query.get('pipeline_id')) || one('SELECT id FROM pipelines WHERE org_id=? ORDER BY position, id', o).id;
    const stages = q('SELECT * FROM stages WHERE pipeline_id=? AND org_id=? ORDER BY position', pid, o);
    const deals = q(`SELECT d.id, d.stage_id, st.position, st.kind FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.pipeline_id=? AND d.created_at BETWEEN ? AND ?${s.sql}`, o, pid, from, to, ...s.args);
    const reached = deals.map(d => {
      if (d.kind === 'won') return Infinity;
      const hist = q('SELECT st.position, st.kind FROM deal_history h JOIN stages st ON st.id=h.to_stage WHERE h.deal_id=?', d.id).filter(h => h.kind === 'open').map(h => h.position);
      return Math.max(d.kind === 'open' ? d.position : -1, ...hist, 0);
    });
    const openStages = stages.filter(x => x.kind === 'open'); const won = stages.find(x => x.kind === 'won');
    const funnel = [...openStages.map(st => ({ stage: st.name, count: reached.filter(p => p >= st.position).length })), { stage: won?.name || 'Won', count: reached.filter(p => p === Infinity).length }];
    funnel.forEach((f, i) => { f.conversion = i && funnel[i - 1].count ? Math.round(100 * f.count / funnel[i - 1].count) : null; });
    const closed = `FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.closed_at BETWEEN ? AND ?${s.sql}`;
    const summary = one(`SELECT SUM(st.kind='won') won, SUM(st.kind='lost') lost, COALESCE(SUM(CASE WHEN st.kind='won' THEN d.value END),0) won_value,
      AVG(CASE WHEN st.kind='won' THEN d.value END) avg_deal, AVG(CASE WHEN st.kind='won' THEN julianday(d.closed_at)-julianday(d.created_at) END) avg_cycle ${closed}`, o, from, to, ...s.args);
    summary.win_rate = summary.won + summary.lost ? Math.round(100 * summary.won / (summary.won + summary.lost)) : null;
    const lost_reasons = q(`SELECT COALESCE(d.lost_reason,'(none)') reason, COUNT(*) n, SUM(d.value) value ${closed} AND st.kind='lost' GROUP BY 1 ORDER BY n DESC`, o, from, to, ...s.args);
    const leaderboard = q('SELECT id, name FROM users WHERE org_id=? ORDER BY name', o).filter(u => core.canSee(ctx.user, u.id)).map(u => ({
      name: u.name,
      ...one(`SELECT SUM(st.kind='won') won, COALESCE(SUM(CASE WHEN st.kind='won' THEN d.value END),0) won_value, SUM(st.kind='lost') lost FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.owner_id=? AND d.closed_at BETWEEN ? AND ?`, o, u.id, from, to),
      open_value: one(`SELECT COALESCE(SUM(d.value),0) v FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND d.owner_id=? AND st.kind='open'`, o, u.id).v,
      activities: one('SELECT COUNT(*) n FROM activities WHERE org_id=? AND owner_id=? AND done=1 AND done_at BETWEEN ? AND ?', o, u.id, from, to).n,
      emails: one("SELECT COUNT(*) n FROM emails WHERE org_id=? AND user_id=? AND direction='out' AND created_at BETWEEN ? AND ?", o, u.id, from, to).n,
      meetings: one("SELECT COUNT(*) n FROM activities WHERE org_id=? AND owner_id=? AND type='meeting' AND COALESCE(start_at, created_at) BETWEEN ? AND ?", o, u.id, from, to).n,
    })).sort((a, b) => b.won_value - a.won_value);
    const cs = inScope(ctx, 'c.owner_id');
    const leads_by_source = q(`SELECT COALESCE(c.source,'(none)') source, COUNT(*) n, SUM(c.lifecycle='customer') customers FROM contacts c WHERE c.org_id=? AND c.created_at BETWEEN ? AND ?${cs.sql} GROUP BY 1 ORDER BY n DESC`, o, from, to, ...cs.args);
    const as = inScope(ctx, 'a.owner_id');
    const activity_by_type = q(`SELECT a.type, COUNT(*) n, SUM(a.done) done FROM activities a WHERE a.org_id=? AND a.created_at BETWEEN ? AND ?${as.sql} GROUP BY a.type`, o, from, to, ...as.args);
    const won_by_month = q(`SELECT substr(d.closed_at,1,7) month, COALESCE(SUM(d.value),0) value, COUNT(*) n FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.org_id=? AND st.kind='won'
      AND d.closed_at>=date('now','start of month','-11 months')${s.sql} GROUP BY 1 ORDER BY 1`, o, ...s.args);
    const emailStats = one(`SELECT COUNT(*) sent, SUM(open_count>0) opened, (SELECT COUNT(*) FROM emails WHERE org_id=? AND direction='in' AND created_at BETWEEN ? AND ?) replies
      FROM emails WHERE org_id=? AND direction='out' AND status IN ('sent','logged') AND created_at BETWEEN ? AND ?`, o, from, to, o, from, to);
    return { from, to: to.slice(0, 10), pipeline_id: pid, funnel, summary, lost_reasons, leaderboard, leads_by_source, activity_by_type, won_by_month, email: emailStats };
  });

  // ---------------- workflows
  r.get('/api/workflows/meta', () => ({ triggers: wf.TRIGGERS, actions: wf.ACTIONS, ops: wf.OPS, deal_fields: wf.DEAL_FIELDS, contact_fields: wf.CONTACT_FIELDS }));
  crud(r, '/api/workflows', 'workflows', { cols: ['name', 'trigger', 'conditions', 'actions', 'active'], req: ['name', 'trigger', 'actions'], json: ['conditions', 'actions'], bool: ['active'],
    roles: ADMIN.concat('manager'), feature: 'automation', list: 'SELECT * FROM workflows WHERE org_id=? ORDER BY name',
    validate(o, ctx, ex) {
      try { wf.validate(o.trigger ?? ex.trigger, JSON.parse(o.conditions ?? ex?.conditions ?? '[]'), JSON.parse(o.actions ?? ex.actions)); } catch (e) { bad(e.message); }
      for (const a of JSON.parse(o.actions ?? ex.actions)) {
        if (a.template_id && !one('SELECT 1 FROM email_templates WHERE id=? AND org_id=?', Number(a.template_id), ctx.org.id)) bad('invalid template');
        if (a.sequence_id && !one('SELECT 1 FROM sequences WHERE id=? AND org_id=?', Number(a.sequence_id), ctx.org.id)) bad('invalid sequence');
        if (a.field === 'owner_id' && a.value && !one('SELECT 1 FROM users WHERE id=? AND org_id=?', Number(a.value), ctx.org.id)) bad('owner must be a user in this workspace');
        for (const k of ['assign', 'to']) if (a[k] && !['owner', 'manager'].includes(a[k]) && !one('SELECT 1 FROM users WHERE id=? AND org_id=?', Number(a[k]), ctx.org.id)) bad('invalid user in action');
      }
    } });

  // ---------------- notifications
  r.get('/api/notifications', ctx => q('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', ctx.user.id));
  r.post('/api/notifications/read', ctx => {
    if (Array.isArray(ctx.body.ids)) for (const id of ctx.body.ids) run('UPDATE notifications SET read=1 WHERE id=? AND user_id=?', Number(id), ctx.user.id);
    else run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id);
  });

  // ---------------- click-to-call
  r.post('/api/calls/dial', async ctx => {
    const tw = require('../lib/twilio'); if (!tw.enabled()) bad('Calling is not configured — set TWILIO_* on the server, or use your phone (tel: link)', 501);
    const c = core.getRecord(ctx, 'contacts', ctx.body.contact_id);
    const sid = await tw.dial(one('SELECT phone FROM users WHERE id=?', ctx.user.id).phone, c.phone);
    const id = insert('activities', { org_id: ctx.org.id, type: 'call', subject: `Call with ${c.name}`, contact_id: c.id, deal_id: ctx.body.deal_id || null, owner_id: ctx.user.id, user_id: ctx.user.id, outcome: 'dialing', note: `Twilio call ${sid}`, start_at: U.isoNow() });
    return { activity_id: id, sid };
  });

  // ---------------- AI assistant (Claude)
  r.post('/api/ai/draft-email', { feature: 'ai' }, async ctx => {
    const c = core.getRecord(ctx, 'contacts', ctx.body.contact_id), deal = ctx.body.deal_id ? one(require('./records').DEF.deals.select + ' AND d.id=?', ctx.org.id, core.getRecord(ctx, 'deals', ctx.body.deal_id).id) : null;
    const company = c.company_id ? one('SELECT * FROM companies WHERE id=?', c.company_id) : null;
    return ai.draftEmail({ sender: ctx.user, contact: c, company, deal, recent: recentText(ctx.org.id, { contact_id: c.id }), instructions: clean(ctx.body.instructions) });
  });
  r.post('/api/ai/summary', { feature: 'ai' }, async ctx => {
    const ent = ctx.body.entity; if (!['contacts', 'deals', 'companies'].includes(ent)) bad('invalid entity');
    const rec = core.getRecord(ctx, ent, ctx.body.id); const { DEF } = require('./records');
    const record = one(DEF[ent].select + ` AND ${DEF[ent].alias}.id=?`, ctx.org.id, rec.id);
    const key = { contacts: 'contact_id', deals: 'deal_id', companies: 'company_id' }[ent];
    return ai.summarize({ kind: ent.slice(0, -1), record, recent: recentText(ctx.org.id, { [key]: rec.id }) });
  });
  r.post('/api/ai/call-summary', { feature: 'ai' }, async ctx => { if (!clean(ctx.body.notes)) bad('notes required'); return ai.summarizeCall({ notes: String(ctx.body.notes).slice(0, 20000) }); });

  // Company enrichment: fetch the homepage (SSRF-guarded); use Claude when configured, otherwise HTML meta tags.
  r.post('/api/companies/:id/enrich', async ctx => {
    const co = core.getRecord(ctx, 'companies', ctx.params.id);
    const domain = co.domain || (co.website && new URL(/^https?:/.test(co.website) ? co.website : 'https://' + co.website).hostname);
    if (!domain) bad('add a website or domain first');
    const page = await U.safeFetch('https://' + domain.replace(/^www\./, ''), { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PipelineHQ enrichment)' } }, 8e5).catch(e => bad(`could not fetch ${domain}: ${e.message}`, 502));
    const html = page.text, meta = n => (html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']+)`, 'i')) || [])[1];
    let found = { description: meta('description') || meta('og:description') || null };
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (ai.enabled() && limits(ctx.org).features.includes('ai')) found = await ai.enrichCompany({ name: co.name, domain, pageText: text });
    const o = { domain, website: co.website || 'https://' + domain };
    for (const k of ['industry', 'size', 'description']) if (found[k] && found[k] !== 'unknown' && !co[k]) o[k] = String(found[k]).slice(0, 1000);
    run(`UPDATE companies SET ${Object.keys(o).map(k => k + '=?').join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`, ...Object.values(o), co.id);
    core.audit(ctx, 'update', 'company', co.id, { enriched: Object.keys(o) });
    return { updated: Object.keys(o), company: one('SELECT * FROM companies WHERE id=?', co.id) };
  });
};
module.exports.quoteTotals = quoteTotals;
