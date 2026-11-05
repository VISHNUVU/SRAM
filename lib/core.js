// Domain core: visibility scope, audit, notifications, events (workflows + webhooks), jobs, custom fields, lead scoring, timeline.
const { q, one, run, insert } = require('./db');
const { bad, clean, json, normEmail, now, emailOk } = require('./util');

// ---------- visibility (team hierarchy)
// owner/admin: everything · manager: self + everyone reporting up to them · rep: own records. Unassigned records are visible to all.
function visibleUserIds(user) {
  if (['owner', 'admin'].includes(user.role)) return null;
  if (user.role === 'manager') {
    return q(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT u.id FROM users u JOIN t ON u.manager_id=t.id WHERE u.org_id=?) SELECT id FROM t`, user.id, user.org_id).map(r => r.id);
  }
  return [user.id];
}
function scopeSql(user, col) {
  const ids = visibleUserIds(user); if (!ids) return { sql: '', args: [] };
  return { sql: ` AND (${col} IS NULL OR ${col} IN (${ids.map(() => '?').join(',')}))`, args: ids };
}
function canSee(user, ownerId) { const ids = visibleUserIds(user); return !ids || ownerId == null || ids.includes(ownerId); }
function canManageUsers(user) { return ['owner', 'admin'].includes(user.role); }

// Fetch a record in the caller's org and visibility scope, or 404.
const OWNED = { contacts: 'owner_id', deals: 'owner_id', activities: 'owner_id', companies: null };
function getRecord(ctx, table, id) {
  const row = one(`SELECT * FROM ${table} WHERE id=? AND org_id=?`, Number(id), ctx.user.org_id);
  if (!row) bad('not found', 404);
  if (OWNED[table] && !canSee(ctx.user, row[OWNED[table]])) {
    // a task is visible if you can see the deal/contact it belongs to
    if (table === 'activities' && ((row.deal_id && canSee(ctx.user, one('SELECT owner_id FROM deals WHERE id=?', row.deal_id)?.owner_id)) ||
      (row.contact_id && canSee(ctx.user, one('SELECT owner_id FROM contacts WHERE id=?', row.contact_id)?.owner_id)))) return row;
    bad('not found', 404);
  }
  return row;
}

// ---------- audit log
function audit(ctx, action, entity, entityId, detail) {
  insert('audit', { org_id: ctx.org?.id ?? ctx.user?.org_id ?? null, user_id: ctx.user?.id ?? null, impersonator_id: ctx.impersonatorId ?? null, action, entity: entity || null,
    entity_id: entityId ?? null, detail: detail == null ? null : JSON.stringify(detail).slice(0, 4000), ip: ctx.ip || null });
}
function diff(before, after) {
  const d = {}; for (const k of Object.keys(after)) if (k !== 'updated_at' && String(before[k] ?? '') !== String(after[k] ?? '')) d[k] = [before[k] ?? null, after[k] ?? null];
  return d;
}

// ---------- jobs
function enqueue(type, payload, delayMs = 0) { return insert('jobs', { type, payload: JSON.stringify(payload), run_at: now() + delayMs }); }

// ---------- notifications
function notify(orgId, userId, text, link = null, { email = false } = {}) {
  if (!userId) return;
  insert('notifications', { org_id: orgId, user_id: userId, text: String(text).slice(0, 500), link });
  if (email) {
    const u = one('SELECT email,name,notify_email FROM users WHERE id=? AND active=1', userId);
    if (u?.notify_email) enqueue('system_email', { to: u.email, subject: text.slice(0, 120), text: `${text}\n\n${process.env.APP_URL || ''}/${link || ''}` });
  }
}
function managerOf(userId) { return one('SELECT manager_id FROM users WHERE id=?', userId)?.manager_id || null; }

// ---------- events → webhooks + workflows
function emit(orgId, event, data, depth = 0) {
  for (const h of q('SELECT * FROM webhooks WHERE org_id=? AND active=1', orgId)) {
    const evs = json(h.events, ['*']);
    if (evs.includes('*') || evs.includes(event)) enqueue('webhook', { webhook_id: h.id, event, data, at: new Date().toISOString() });
  }
  if (depth < 3) require('./workflows').run(orgId, event, data, depth);
}

// ---------- custom fields
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'url', 'email', 'textarea'];
function fieldDefs(orgId, entity) { return q('SELECT * FROM field_defs WHERE org_id=? AND entity=? ORDER BY position, id', orgId, entity).map(f => ({ ...f, options: json(f.options, []) })); }
function mergeCustom(orgId, entity, input, existingJson, partial) {
  const defs = fieldDefs(orgId, entity), cur = json(existingJson, {}), out = { ...cur };
  input = input && typeof input === 'object' ? input : {};
  for (const d of defs) {
    if (!(d.key in input)) { if (!partial && d.required && (cur[d.key] == null || cur[d.key] === '')) bad(`${d.label} is required`); continue; }
    let v = input[d.key];
    if (v === '' || v == null) { if (d.required) bad(`${d.label} is required`); delete out[d.key]; continue; }
    if (d.type === 'number') { v = Number(v); if (!Number.isFinite(v)) bad(`${d.label} must be a number`); }
    else if (d.type === 'checkbox') v = v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
    else if (d.type === 'date') { v = String(v).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) bad(`${d.label} must be a date`); }
    else if (d.type === 'select') { v = String(v); if (!d.options.includes(v)) bad(`${d.label} must be one of: ${d.options.join(', ')}`); }
    else if (d.type === 'email') { v = String(v).trim(); if (!emailOk(v)) bad(`${d.label} must be an email`); }
    else if (d.type === 'url') { v = String(v).trim(); if (!/^https?:\/\//i.test(v)) v = 'https://' + v; }
    else v = clean(String(v)).slice(0, 5000);
    out[d.key] = v;
  }
  return JSON.stringify(out);
}

// ---------- lead scoring
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|live|aol|icloud|proton|protonmail|gmx|mail|yandex)\./i;
function scoreContact(contactId) {
  const c = one('SELECT * FROM contacts WHERE id=?', contactId); if (!c) return 0;
  const co = c.company_id ? one('SELECT * FROM companies WHERE id=?', c.company_id) : null;
  const custom = json(c.custom, {});
  const vals = {
    name: c.name, email: c.email, phone: c.phone, title: c.title, source: c.source, lifecycle: c.lifecycle,
    'company.industry': co?.industry, 'company.size': co?.size, 'company.name': co?.name,
    _opens: one('SELECT COALESCE(SUM(open_count),0) n FROM emails WHERE contact_id=?', c.id).n,
    _replies: one("SELECT COUNT(*) n FROM emails WHERE contact_id=? AND direction='in'", c.id).n,
    _meetings: one("SELECT COUNT(*) n FROM activities WHERE contact_id=? AND type='meeting'", c.id).n,
  };
  for (const [k, v] of Object.entries(custom)) vals['custom.' + k] = v;
  let score = 0;
  for (const r of q('SELECT * FROM scoring_rules WHERE org_id=?', c.org_id)) {
    const v = vals[r.field], s = v == null ? '' : String(v).toLowerCase(), t = String(r.value ?? '').toLowerCase();
    const hit = { contains: () => s.includes(t), eq: () => s === t, neq: () => s !== t, gt: () => Number(v) > Number(r.value), lt: () => Number(v) < Number(r.value),
      not_empty: () => s !== '', empty: () => s === '', business_email: () => !!c.email && !FREE_MAIL.test(c.email) }[r.op]?.();
    if (hit) score += r.points;
  }
  run('UPDATE contacts SET lead_score=? WHERE id=?', score, c.id);
  return score;
}

// ---------- round-robin assignment among active reps/managers (falls back to everyone)
function nextAssignee(orgId) {
  let users = q("SELECT id FROM users WHERE org_id=? AND active=1 AND role IN ('rep','manager') ORDER BY id", orgId);
  if (!users.length) users = q('SELECT id FROM users WHERE org_id=? AND active=1 ORDER BY id', orgId);
  if (!users.length) return null;
  const org = one('SELECT rr_index FROM orgs WHERE id=?', orgId);
  run('UPDATE orgs SET rr_index=rr_index+1 WHERE id=?', orgId);
  return users[org.rr_index % users.length].id;
}

// ---------- contact upsert by email (forms, booking, inbound, import)
function upsertContactByEmail(orgId, { name, email, phone, title, company, source, owner_id }) {
  email = normEmail(email);
  let c = email && one('SELECT * FROM contacts WHERE org_id=? AND lower(email)=?', orgId, email);
  let companyId = c?.company_id || null;
  if (company && !companyId) {
    companyId = one('SELECT id FROM companies WHERE org_id=? AND lower(name)=lower(?)', orgId, company)?.id
      || insert('companies', { org_id: orgId, name: clean(company), domain: email && !FREE_MAIL.test(email) ? email.split('@')[1] : null });
  }
  if (c) {
    run(`UPDATE contacts SET phone=COALESCE(phone,?), title=COALESCE(title,?), company_id=COALESCE(company_id,?), updated_at=CURRENT_TIMESTAMP WHERE id=?`, phone || null, title || null, companyId, c.id);
    return { contact: one('SELECT * FROM contacts WHERE id=?', c.id), created: false };
  }
  const id = insert('contacts', { org_id: orgId, name: clean(name) || (email ? email.split('@')[0] : 'Unknown'), email, phone: phone || null, title: title || null,
    company_id: companyId, source: source || null, owner_id: owner_id ?? null, lifecycle: 'lead' });
  return { contact: one('SELECT * FROM contacts WHERE id=?', id), created: true };
}

// ---------- timeline: activities + emails + stage changes + field changes, newest first
function timeline(orgId, { deal_id, contact_id, company_id }) {
  const items = [];
  const where = deal_id ? ['deal_id', deal_id] : contact_id ? ['contact_id', contact_id] : ['company_id', company_id];
  let acts;
  if (company_id) acts = q(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id=a.owner_id WHERE a.org_id=? AND (a.company_id=? OR a.contact_id IN (SELECT id FROM contacts WHERE company_id=?) OR a.deal_id IN (SELECT id FROM deals WHERE company_id=?))`, orgId, company_id, company_id, company_id);
  else acts = q(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id=a.owner_id WHERE a.org_id=? AND a.${where[0]}=?`, orgId, where[1]);
  for (const a of acts) items.push({ kind: 'activity', at: a.start_at || a.created_at, ...a });
  const emails = company_id ? q('SELECT * FROM emails WHERE org_id=? AND contact_id IN (SELECT id FROM contacts WHERE company_id=?)', orgId, company_id)
    : deal_id ? q('SELECT * FROM emails WHERE org_id=? AND (deal_id=? OR contact_id=(SELECT contact_id FROM deals WHERE id=?))', orgId, deal_id, deal_id)
      : q('SELECT * FROM emails WHERE org_id=? AND contact_id=?', orgId, contact_id);
  for (const e of emails) items.push({ kind: 'email', at: e.sent_at || e.created_at, ...e, body: e.body?.slice(0, 2000) });
  if (deal_id) for (const h of q(`SELECT h.*, f.name from_name, t.name to_name, u.name user_name FROM deal_history h LEFT JOIN stages f ON f.id=h.from_stage
    LEFT JOIN stages t ON t.id=h.to_stage LEFT JOIN users u ON u.id=h.user_id WHERE h.deal_id=?`, deal_id)) items.push({ kind: 'stage', ...h });
  const ent = deal_id ? ['deal', deal_id] : contact_id ? ['contact', contact_id] : ['company', company_id];
  for (const a of q(`SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.org_id=? AND a.entity=? AND a.entity_id=? AND a.action IN ('update','create')`, orgId, ent[0], ent[1]))
    items.push({ kind: 'change', at: a.at, action: a.action, user_name: a.user_name, detail: json(a.detail, {}) });
  return items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300);
}

module.exports = { visibleUserIds, scopeSql, canSee, canManageUsers, getRecord, audit, diff, enqueue, notify, managerOf, emit, FIELD_TYPES, fieldDefs, mergeCustom,
  scoreContact, nextAssignee, upsertContactByEmail, timeline, FREE_MAIL };
