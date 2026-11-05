// Workspace administration: team & hierarchy, org settings, billing, API keys, webhooks, audit log, GDPR export/delete, super-admin console.
const fs = require('node:fs');
const { q, one, run, insert, tx } = require('../lib/db');
const U = require('../lib/util');
const { bad, clean, json, randomToken, sha256, verifyPw } = U;
const core = require('../lib/core');
const { crud } = require('../lib/crud');
const { limits, PLANS } = require('../lib/plans');
const stripe = require('../lib/stripe');
const { createSession, cookies, setCookie } = require('../lib/http');

const ADMIN = ['owner', 'admin'];
const ORG_TABLES = ['companies', 'contacts', 'pipelines', 'stages', 'deals', 'deal_history', 'activities', 'emails', 'email_templates', 'sequences', 'enrollments', 'field_defs', 'views',
  'forms', 'scoring_rules', 'booking_pages', 'products', 'price_books', 'quotes', 'quote_items', 'quotas', 'workflows', 'notifications', 'files', 'audit'];

module.exports = function (r) {
  // ---------------- team & hierarchy
  r.get('/api/team', ctx => q('SELECT id, name, email, role, manager_id, active, phone, totp_enabled, created_at FROM users WHERE org_id=? ORDER BY active DESC, name', ctx.org.id));
  r.patch('/api/team/:id', { roles: ADMIN }, ctx => {
    const u = one('SELECT * FROM users WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!u) bad('not found', 404);
    const b = ctx.body, o = {};
    if ('role' in b) {
      if (!['owner', 'admin', 'manager', 'rep'].includes(b.role)) bad('invalid role');
      if ((b.role === 'owner' || u.role === 'owner') && ctx.user.role !== 'owner') bad('only the owner can transfer ownership', 403);
      if (u.id === ctx.user.id && b.role !== u.role) bad('you cannot change your own role');
      o.role = b.role;
      if (b.role === 'owner') run("UPDATE users SET role='admin' WHERE id=?", ctx.user.id); // transfer
    }
    if ('manager_id' in b) {
      const m = b.manager_id ? one('SELECT id FROM users WHERE id=? AND org_id=?', Number(b.manager_id), ctx.org.id) : null;
      if (b.manager_id && !m) bad('invalid manager');
      if (m) { // prevent cycles
        let cur = m.id; for (let i = 0; cur && i < 50; i++) { if (cur === u.id) bad('that would create a reporting loop'); cur = one('SELECT manager_id FROM users WHERE id=?', cur)?.manager_id; }
      }
      o.manager_id = m?.id ?? null;
    }
    if ('active' in b) {
      if (u.id === ctx.user.id) bad('you cannot deactivate yourself'); if (u.role === 'owner') bad('the owner cannot be deactivated');
      o.active = b.active ? 1 : 0;
      if (o.active && !u.active) require('./auth').seatCheck(ctx.org);
      if (!o.active) { run('DELETE FROM sessions WHERE user_id=?', u.id); run('DELETE FROM api_keys WHERE user_id=?', u.id); }
    }
    if (b.reassign_to && b.active === false) { // hand records to someone else when deactivating
      const to = one('SELECT id FROM users WHERE id=? AND org_id=? AND active=1', Number(b.reassign_to), ctx.org.id); if (!to) bad('invalid reassignment target');
      for (const t of ['contacts', 'deals', 'activities', 'companies']) run(`UPDATE ${t} SET owner_id=? WHERE owner_id=? AND org_id=?`, to.id, u.id, ctx.org.id);
    }
    if (Object.keys(o).length) run(`UPDATE users SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(o), u.id);
    core.audit(ctx, 'update', 'user', u.id, o);
  });

  // ---------------- org settings
  r.get('/api/org', ctx => ({ ...ctx.org, lost_reasons: json(ctx.org.lost_reasons, []), stripe_customer: undefined, inbound_token: undefined }));
  r.patch('/api/org', { roles: ADMIN }, ctx => {
    const b = ctx.body, o = {};
    if ('name' in b) { if (!clean(b.name)) bad('name required'); o.name = clean(b.name).slice(0, 120); }
    if ('currency' in b) { if (!/^[A-Z]{3}$/.test(b.currency)) bad('currency must be a 3-letter code like USD'); o.currency = b.currency; }
    if ('timezone' in b) { if (!U.validTz(b.timezone)) bad('invalid time zone'); o.timezone = b.timezone; }
    if ('stall_days' in b) { const n = Number(b.stall_days); if (!(n >= 1 && n <= 365)) bad('stall days must be 1–365'); o.stall_days = n; }
    if ('lost_reasons' in b) { if (!Array.isArray(b.lost_reasons)) bad('lost reasons must be a list'); o.lost_reasons = JSON.stringify(b.lost_reasons.map(clean).filter(Boolean).slice(0, 50)); }
    if (Object.keys(o).length) run(`UPDATE orgs SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(o), ctx.org.id);
    core.audit(ctx, 'update', 'org', ctx.org.id, Object.keys(o));
  });
  r.post('/api/org/inbound-token', { roles: ADMIN }, ctx => { run('UPDATE orgs SET inbound_token=? WHERE id=?', randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, 'x'), ctx.org.id); });

  // ---------------- billing
  r.get('/api/billing', ctx => ({ plans: PLANS, current: limits(ctx.org), org_plan: ctx.org.plan, sub_status: ctx.org.sub_status, seats: ctx.org.seats, stripe: stripe.enabled(),
    price_label: process.env.PRICE_LABEL || '$29 per user / month',
    usage: { users: one('SELECT COUNT(*) n FROM users WHERE org_id=? AND active=1', ctx.org.id).n, contacts: one('SELECT COUNT(*) n FROM contacts WHERE org_id=?', ctx.org.id).n,
      pipelines: one('SELECT COUNT(*) n FROM pipelines WHERE org_id=?', ctx.org.id).n } }));
  r.post('/api/billing/checkout', { roles: ['owner'] }, async ctx => {
    const seats = Math.max(Number(ctx.body.seats) || 0, one('SELECT COUNT(*) n FROM users WHERE org_id=? AND active=1', ctx.org.id).n, 1);
    if (!stripe.enabled()) { // dev mode: no payment provider configured
      if (process.env.NODE_ENV === 'production') bad('billing is not configured', 501);
      run("UPDATE orgs SET plan='pro', sub_status='active', seats=? WHERE id=?", seats, ctx.org.id); core.audit(ctx, 'plan_change', 'org', ctx.org.id, { plan: 'pro', dev: true });
      return { dev_mode: true };
    }
    return { url: await stripe.checkout(ctx.org, ctx.user, seats) };
  });
  r.post('/api/billing/portal', { roles: ['owner'] }, async ctx => {
    if (!stripe.enabled()) {
      if (process.env.NODE_ENV === 'production') bad('billing is not configured', 501);
      run("UPDATE orgs SET plan='free', sub_status=NULL, trial_ends_at=NULL WHERE id=?", ctx.org.id); core.audit(ctx, 'plan_change', 'org', ctx.org.id, { plan: 'free', dev: true });
      return { dev_mode: true };
    }
    try { return { url: await stripe.portal(ctx.org) }; } catch (e) { bad(e.message); }
  });

  // ---------------- API keys
  r.get('/api/api-keys', ctx => q('SELECT id, name, prefix, last_used, created_at, user_id FROM api_keys WHERE org_id=? AND (user_id=? OR ?) ORDER BY id DESC', ctx.org.id, ctx.user.id, ADMIN.includes(ctx.user.role) ? 1 : 0));
  r.post('/api/api-keys', { feature: 'api' }, ctx => {
    if (ctx.via === 'api') bad('create API keys from the app', 403);
    if (!clean(ctx.body.name)) bad('name required');
    const key = 'crm_' + randomToken(30);
    insert('api_keys', { org_id: ctx.org.id, user_id: ctx.user.id, name: clean(ctx.body.name).slice(0, 100), prefix: key.slice(0, 10), key_hash: sha256(key) });
    core.audit(ctx, 'create', 'api_key', null, { name: ctx.body.name });
    return { key, note: 'Copy this key now — it will not be shown again.' };
  });
  r.del('/api/api-keys/:id', ctx => { run('DELETE FROM api_keys WHERE id=? AND org_id=? AND (user_id=? OR ?)', Number(ctx.params.id), ctx.org.id, ctx.user.id, ADMIN.includes(ctx.user.role) ? 1 : 0); core.audit(ctx, 'delete', 'api_key', Number(ctx.params.id)); });

  // ---------------- webhooks
  crud(r, '/api/webhooks', 'webhooks', { cols: ['url', 'events', 'active'], req: ['url'], json: ['events'], bool: ['active'], roles: ADMIN, feature: 'api',
    defaults: () => ({ secret: 'whsec_' + randomToken(24) }),
    validate(o) { if ('url' in o && !/^https?:\/\/.+/.test(o.url)) bad('URL must start with http(s)://'); if ('events' in o && !Array.isArray(JSON.parse(o.events))) bad('events must be a list'); } });
  r.post('/api/webhooks/:id/test', { roles: ADMIN, feature: 'api' }, ctx => {
    const h = one('SELECT * FROM webhooks WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!h) bad('not found', 404);
    core.enqueue('webhook', { webhook_id: h.id, event: 'ping', data: { message: 'Test from PipelineHQ' }, at: new Date().toISOString() });
    setImmediate(() => require('../lib/worker').runJobs().catch(() => { }));
  });

  // ---------------- audit log
  r.get('/api/audit', { roles: ADMIN }, ctx => {
    let sql = 'SELECT a.*, u.name user_name, i.name impersonator_name FROM audit a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users i ON i.id=a.impersonator_id WHERE a.org_id=?'; const args = [ctx.org.id];
    for (const k of ['entity', 'user_id', 'action']) if (ctx.query.get(k)) { sql += ` AND a.${k}=?`; args.push(ctx.query.get(k)); }
    if (ctx.query.get('before')) { sql += ' AND a.id<?'; args.push(Number(ctx.query.get('before'))); }
    return q(sql + ' ORDER BY a.id DESC LIMIT 200', ...args).map(a => ({ ...a, detail: json(a.detail, a.detail) }));
  });

  // ---------------- GDPR: full export, workspace deletion
  r.get('/api/org/export', { roles: ['owner'] }, ctx => {
    const out = { exported_at: new Date().toISOString(), org: { ...ctx.org, stripe_customer: undefined }, users: q('SELECT id, name, email, role, manager_id, active, created_at FROM users WHERE org_id=?', ctx.org.id) };
    for (const t of ORG_TABLES) out[t] = q(`SELECT * FROM ${t} WHERE org_id=?`, ctx.org.id);
    out.files = out.files.map(f => ({ ...f, path: undefined }));
    core.audit(ctx, 'export', 'org', ctx.org.id);
    ctx.send(JSON.stringify(out, null, 1), 'application/json', { 'Content-Disposition': `attachment; filename="pipelinehq-export-${new Date().toISOString().slice(0, 10)}.json"` });
  });
  r.post('/api/org/delete', { roles: ['owner'] }, ctx => {
    const u = one('SELECT pw FROM users WHERE id=?', ctx.user.id);
    if (u.pw ? !verifyPw(String(ctx.body.password || ''), u.pw) : ctx.body.confirm !== ctx.org.name) bad('confirmation failed', 403);
    for (const f of q('SELECT path FROM files WHERE org_id=?', ctx.org.id)) { try { fs.unlinkSync(f.path); } catch { } }
    tx(() => {
      const uids = q('SELECT id FROM users WHERE org_id=?', ctx.org.id).map(x => x.id);
      for (const id of uids) run('DELETE FROM sessions WHERE user_id=?', id);
      run('DELETE FROM tokens WHERE org_id=?', ctx.org.id);
      run('DELETE FROM quote_items WHERE org_id=?', ctx.org.id);
      run('DELETE FROM orgs WHERE id=?', ctx.org.id); // cascades to every org-scoped table
      run('DELETE FROM audit WHERE org_id=?', ctx.org.id);
    });
    setCookie(ctx.res, 'sid', '', 0);
  });

  // ---------------- super-admin console (SUPERADMIN_EMAILS)
  r.get('/api/sa/orgs', { superadmin: true }, () => q(`SELECT o.id, o.name, o.plan, o.sub_status, o.seats, o.trial_ends_at, o.created_at,
    (SELECT COUNT(*) FROM users u WHERE u.org_id=o.id AND u.active=1) users, (SELECT COUNT(*) FROM contacts c WHERE c.org_id=o.id) contacts,
    (SELECT COUNT(*) FROM deals d WHERE d.org_id=o.id) deals, (SELECT MAX(at) FROM audit a WHERE a.org_id=o.id) last_activity,
    (SELECT email FROM users u WHERE u.org_id=o.id AND u.role='owner') owner_email FROM orgs o ORDER BY o.id DESC LIMIT 1000`));
  r.get('/api/sa/stats', { superadmin: true }, () => ({
    orgs: one('SELECT COUNT(*) n FROM orgs').n, paying: one("SELECT COUNT(*) n FROM orgs WHERE plan='pro' AND sub_status='active'").n,
    trialing: one('SELECT COUNT(*) n FROM orgs WHERE trial_ends_at>?', Date.now()).n, users: one('SELECT COUNT(*) n FROM users WHERE active=1').n,
    signups_30d: one("SELECT COUNT(*) n FROM orgs WHERE created_at>=datetime('now','-30 days')").n, active_7d: one("SELECT COUNT(DISTINCT org_id) n FROM audit WHERE at>=datetime('now','-7 days')").n,
    jobs_failed: one("SELECT COUNT(*) n FROM jobs WHERE status='failed'").n,
  }));
  r.post('/api/sa/impersonate', { superadmin: true }, ctx => {
    if (ctx.impersonatorId) bad('stop the current impersonation first');
    const target = one("SELECT id, org_id FROM users WHERE org_id=? AND role='owner' AND active=1", Number(ctx.body.org_id)) || one('SELECT id, org_id FROM users WHERE id=?', Number(ctx.body.user_id));
    if (!target) bad('user not found');
    setCookie(ctx.res, 'sid_admin', cookies(ctx.req).sid, 3600);
    createSession(ctx.res, target.id, ctx.user.id);
    core.audit({ ...ctx, user: { id: target.id, org_id: target.org_id }, impersonatorId: ctx.user.id }, 'impersonate_start', 'user', target.id);
  });
  r.post('/api/sa/stop', ctx => {
    if (!ctx.impersonatorId) bad('not impersonating');
    core.audit(ctx, 'impersonate_stop', 'user', ctx.user.id);
    run('DELETE FROM sessions WHERE token_hash=?', sha256(cookies(ctx.req).sid));
    const orig = cookies(ctx.req).sid_admin;
    setCookie(ctx.res, 'sid_admin', '', 0);
    if (orig && one('SELECT 1 FROM sessions WHERE token_hash=? AND expires>?', sha256(orig), Date.now())) { ctx.res.setHeader('Set-Cookie', [...[].concat(ctx.res.getHeader('Set-Cookie')), `sid=${encodeURIComponent(orig)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 86400}${process.env.COOKIE_SECURE === '1' ? '; Secure' : ''}`]); }
    else createSession(ctx.res, ctx.impersonatorId);
  });
  r.post('/api/sa/orgs/:id/plan', { superadmin: true }, ctx => {
    const { plan, trial_days, seats } = ctx.body; const o = {};
    if (plan) { if (!['free', 'pro'].includes(plan)) bad('invalid plan'); o.plan = plan; o.sub_status = plan === 'pro' ? 'active' : null; }
    if (trial_days != null) o.trial_ends_at = Date.now() + Number(trial_days) * 864e5;
    if (seats) o.seats = Number(seats);
    if (Object.keys(o).length) run(`UPDATE orgs SET ${Object.keys(o).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(o), Number(ctx.params.id));
  });
};
