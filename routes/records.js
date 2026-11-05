// Core CRM records: contacts, companies, deals, activities (tasks/calls/meetings/notes).
// List filters + saved-view friendly query strings, hierarchy scoping, custom fields, timeline, search, bulk, import/export, duplicates/merge, files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, one, run, insert, tx, DATA_DIR } = require('../lib/db');
const U = require('../lib/util');
const { bad, clean, emailOk, normEmail, json } = U;
const core = require('../lib/core');
const { limits } = require('../lib/plans');

const LIFECYCLES = ['lead', 'prospect', 'customer', 'churned', 'other'];
const ACT_TYPES = ['task', 'call', 'email', 'meeting', 'note'];
const ENTITY = { contacts: 'contact', companies: 'company', deals: 'deal', activities: 'activity' };

const DEF = {
  contacts: {
    alias: 'c', owner: 'c.owner_id', custom: true,
    select: `SELECT c.*, co.name company_name, u.name owner_name FROM contacts c LEFT JOIN companies co ON co.id=c.company_id LEFT JOIN users u ON u.id=c.owner_id WHERE c.org_id=?`,
    search: ['c.name', 'c.email', 'c.phone', 'co.name'], eq: { owner_id: 'c.owner_id', company_id: 'c.company_id', lifecycle: 'c.lifecycle', source: 'c.source' },
    sorts: { name: 'c.name', created_at: 'c.created_at', updated_at: 'c.updated_at', lead_score: 'c.lead_score', company: 'co.name' },
  },
  companies: {
    alias: 'co', owner: null, custom: true,
    select: `SELECT co.*, u.name owner_name, (SELECT COUNT(*) FROM contacts x WHERE x.company_id=co.id) contact_count,
      (SELECT COALESCE(SUM(d.value),0) FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.company_id=co.id AND s.kind='open') open_value
      FROM companies co LEFT JOIN users u ON u.id=co.owner_id WHERE co.org_id=?`,
    search: ['co.name', 'co.website', 'co.industry'], eq: { owner_id: 'co.owner_id', industry: 'co.industry', size: 'co.size' },
    sorts: { name: 'co.name', created_at: 'co.created_at', industry: 'co.industry' },
  },
  deals: {
    alias: 'd', owner: 'd.owner_id', custom: true,
    select: `SELECT d.*, s.name stage_name, s.kind stage_kind, s.probability, p.name pipeline_name, c.name contact_name, c.email contact_email, co.name company_name, u.name owner_name
      FROM deals d JOIN stages s ON s.id=d.stage_id JOIN pipelines p ON p.id=d.pipeline_id LEFT JOIN contacts c ON c.id=d.contact_id
      LEFT JOIN companies co ON co.id=d.company_id LEFT JOIN users u ON u.id=d.owner_id WHERE d.org_id=?`,
    search: ['d.title', 'c.name', 'co.name'], eq: { owner_id: 'd.owner_id', pipeline_id: 'd.pipeline_id', stage_id: 'd.stage_id', contact_id: 'd.contact_id', company_id: 'd.company_id' },
    sorts: { title: 'd.title', value: 'd.value', close_date: 'd.close_date', created_at: 'd.created_at', updated_at: 'd.updated_at', stage: 's.position' },
  },
  activities: {
    alias: 'a', owner: 'a.owner_id', custom: false,
    select: `SELECT a.*, d.title deal_title, c.name contact_name, co.name company_name, u.name owner_name FROM activities a LEFT JOIN deals d ON d.id=a.deal_id
      LEFT JOIN contacts c ON c.id=a.contact_id LEFT JOIN companies co ON co.id=a.company_id LEFT JOIN users u ON u.id=a.owner_id WHERE a.org_id=?`,
    search: ['a.note', 'a.subject'], eq: { owner_id: 'a.owner_id', type: 'a.type', deal_id: 'a.deal_id', contact_id: 'a.contact_id', company_id: 'a.company_id' },
    sorts: { due_date: 'a.due_date', created_at: 'a.created_at', start_at: 'a.start_at' },
  },
};

// Build WHERE clauses from a query string (shared by list, export, saved views, bulk-by-filter).
function buildQuery(ctx, entity, qs) {
  const d = DEF[entity], A = d.alias; let sql = d.select; const args = [ctx.user.org_id];
  if (d.owner) { const s = core.scopeSql(ctx.user, d.owner); sql += s.sql; args.push(...s.args); }
  const g = k => { const v = qs.get(k); return v == null || v === '' ? null : v; };
  if (g('q')) { const like = `%${g('q')}%`; sql += ` AND (${d.search.map(c => `${c} LIKE ?`).join(' OR ')})`; args.push(...d.search.map(() => like)); }
  for (const [k, col] of Object.entries(d.eq)) if (g(k) != null) {
    if (g(k) === 'none') sql += ` AND ${col} IS NULL`;
    else { const vals = g(k).split(','); sql += ` AND ${col} IN (${vals.map(() => '?').join(',')})`; args.push(...vals); }
  }
  if (g('mine') && d.owner) { sql += ` AND ${d.owner}=?`; args.push(ctx.user.id); }
  if (g('created_from')) { sql += ` AND ${A}.created_at>=?`; args.push(g('created_from')); }
  if (g('created_to')) { sql += ` AND ${A}.created_at<?`; args.push(g('created_to') + ' 99'); }
  if (entity === 'contacts') {
    if (g('min_score')) { sql += ' AND c.lead_score>=?'; args.push(Number(g('min_score'))); }
    if (g('has_email')) sql += " AND c.email IS NOT NULL AND c.email<>''";
  }
  if (entity === 'deals') {
    if (g('status')) { sql += ' AND s.kind=?'; args.push(g('status') === 'open' ? 'open' : g('status') === 'won' ? 'won' : 'lost'); }
    if (g('min_value')) { sql += ' AND d.value>=?'; args.push(Number(g('min_value'))); }
    if (g('max_value')) { sql += ' AND d.value<=?'; args.push(Number(g('max_value'))); }
    if (g('close_from')) { sql += ' AND d.close_date>=?'; args.push(g('close_from')); }
    if (g('close_to')) { sql += ' AND d.close_date<=?'; args.push(g('close_to')); }
  }
  if (entity === 'activities') {
    if (g('done') != null) { sql += ' AND a.done=?'; args.push(g('done') === '1' || g('done') === 'true' ? 1 : 0); }
    const today = new Date().toISOString().slice(0, 10);
    const due = g('due');
    if (due === 'overdue') { sql += ' AND a.done=0 AND a.due_date<?'; args.push(today); }
    else if (due === 'today') { sql += ' AND a.due_date=?'; args.push(today); }
    else if (due === 'week') { sql += ' AND a.due_date>=? AND a.due_date<=?'; args.push(today, new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)); }
    else if (due === 'upcoming') { sql += " AND (a.due_date>=? OR a.start_at>=?)"; args.push(today, today); }
  }
  for (const [k, v] of qs) {
    const m = /^custom\.([a-z0-9_]{1,40})$/.exec(k);
    if (m && d.custom && v !== '') { sql += ` AND json_extract(${A}.custom, '$.${m[1]}') = ?`; args.push(v); }
  }
  const sortKey = (g('sort') || '').replace(/^-/, ''), dir = (g('sort') || '').startsWith('-') ? 'DESC' : 'ASC';
  sql += d.sorts[sortKey] ? ` ORDER BY ${d.sorts[sortKey]} ${dir} NULLS LAST, ${A}.id DESC` : ` ORDER BY ${A}.id DESC`;
  return { sql, args };
}
const decode = row => (row && typeof row.custom === 'string' ? { ...row, custom: json(row.custom, {}) } : row);

function orgRef(ctx, table, id, label) {
  if (id == null || id === '') return null;
  const r = one(`SELECT * FROM ${table} WHERE id=? AND org_id=?`, Number(id), ctx.user.org_id);
  if (!r) bad(`invalid ${label}`); return r;
}
function ownerRef(ctx, id) { if (id == null || id === '') return null; const u = one('SELECT id FROM users WHERE id=? AND org_id=?', Number(id), ctx.user.org_id); if (!u) bad('invalid owner'); return u.id; }
const toSqlTime = v => { if (!v) return null; const d = new Date(v); if (isNaN(d)) bad('invalid date/time'); return d.toISOString().replace('T', ' ').slice(0, 19); };
const dateOnly = v => { if (v == null || v === '') return null; const s = String(v).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) bad('dates must be YYYY-MM-DD'); return s; };
const domainOf = w => { try { return new URL(/^https?:/i.test(w) ? w : 'https://' + w).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

// Validate + normalize input for an entity. `ex` = existing row on update.
function prepare(ctx, entity, b, ex) {
  const o = {}, has = k => k in b, partial = !!ex;
  const text = (k, max = 500) => { if (has(k)) o[k] = clean(b[k] == null ? '' : String(b[k])).slice(0, max) || null; };
  if (entity === 'contacts') {
    text('name', 200); text('phone', 50); text('title', 200); text('source', 100);
    if (has('email')) { const e = normEmail(b.email); if (e && !emailOk(e)) bad('invalid email address'); o.email = e; }
    if (has('company_id')) o.company_id = orgRef(ctx, 'companies', b.company_id, 'company')?.id ?? null;
    if (has('company_name') && !o.company_id && clean(b.company_name)) o.company_id = one('SELECT id FROM companies WHERE org_id=? AND lower(name)=lower(?)', ctx.user.org_id, clean(b.company_name))?.id ?? insert('companies', { org_id: ctx.user.org_id, name: clean(b.company_name), domain: o.email && !core.FREE_MAIL.test(o.email) ? o.email.split('@')[1] : null });
    if (has('lifecycle')) { if (!LIFECYCLES.includes(b.lifecycle)) bad('invalid lifecycle stage'); o.lifecycle = b.lifecycle; }
    if (!partial && !o.name) bad('name is required'); if (partial && has('name') && !o.name) bad('name is required');
  }
  if (entity === 'companies') {
    text('name', 200); text('industry', 100); text('size', 50); text('description', 2000); text('phone', 50);
    if (has('website')) { o.website = clean(b.website) || null; o.domain = o.website ? domainOf(o.website) : null; }
    if (!partial && !o.name) bad('name is required'); if (partial && has('name') && !o.name) bad('name is required');
  }
  if (entity === 'deals') {
    text('title', 200); text('lost_reason', 200);
    if (has('value')) { const v = b.value === '' || b.value == null ? 0 : Number(b.value); if (!Number.isFinite(v) || v < 0) bad('value must be a positive number'); o.value = v; }
    if (has('close_date')) o.close_date = dateOnly(b.close_date);
    if (has('contact_id')) o.contact_id = orgRef(ctx, 'contacts', b.contact_id, 'contact')?.id ?? null;
    if (has('company_id')) o.company_id = orgRef(ctx, 'companies', b.company_id, 'company')?.id ?? null;
    if (o.contact_id && !o.company_id && !ex?.company_id) o.company_id = one('SELECT company_id FROM contacts WHERE id=?', o.contact_id).company_id;
    let pipelineId = ex?.pipeline_id;
    if (has('pipeline_id') && b.pipeline_id) { pipelineId = orgRef(ctx, 'pipelines', b.pipeline_id, 'pipeline').id; o.pipeline_id = pipelineId; }
    if (!pipelineId) { pipelineId = one('SELECT id FROM pipelines WHERE org_id=? ORDER BY position, id LIMIT 1', ctx.user.org_id)?.id; o.pipeline_id = pipelineId; }
    if (has('stage_id') && b.stage_id) {
      const s = orgRef(ctx, 'stages', b.stage_id, 'stage'); if (s.pipeline_id !== pipelineId) bad('stage does not belong to the pipeline'); o.stage_id = s.id;
    } else if (!ex || (o.pipeline_id && o.pipeline_id !== ex.pipeline_id)) {
      o.stage_id = one("SELECT id FROM stages WHERE pipeline_id=? ORDER BY position, id LIMIT 1", pipelineId)?.id;
      if (!o.stage_id) bad('the pipeline has no stages');
    }
    if (!partial && !o.title) bad('title is required'); if (partial && has('title') && !o.title) bad('title is required');
  }
  if (entity === 'activities') {
    text('subject', 300); text('note', 10000); text('outcome', 200);
    if (has('type')) { if (!ACT_TYPES.includes(b.type)) bad('invalid activity type'); o.type = b.type; }
    if (has('due_date')) o.due_date = dateOnly(b.due_date);
    if (has('start_at')) o.start_at = toSqlTime(b.start_at);
    if (has('duration_min')) o.duration_min = b.duration_min === '' || b.duration_min == null ? null : Math.max(0, Math.min(1440, Number(b.duration_min) || 0));
    if (has('done')) { o.done = b.done === true || b.done === 1 || b.done === '1' || b.done === 'true' ? 1 : 0; o.done_at = o.done ? U.isoNow() : null; }
    for (const [k, t] of [['deal_id', 'deals'], ['contact_id', 'contacts'], ['company_id', 'companies']]) if (has(k)) o[k] = orgRef(ctx, t, b[k], k.replace('_id', ''))?.id ?? null;
    if (!partial && !o.note && !o.subject) bad('add a subject or note');
  }
  if (has('owner_id')) o.owner_id = ownerRef(ctx, b.owner_id);
  if (DEF[entity].custom && (has('custom') || !partial)) o.custom = core.mergeCustom(ctx.user.org_id, entity, b.custom, ex?.custom, partial && !has('custom'));
  return o;
}

function detail(ctx, entity, id) {
  const row = core.getRecord(ctx, entity, id);
  const out = decode(one(DEF[entity].select + ` AND ${DEF[entity].alias}.id=?`, ctx.user.org_id, row.id));
  const files = q('SELECT id, name, mime, size, created_at FROM files WHERE org_id=? AND entity=? AND entity_id=? ORDER BY id DESC', ctx.user.org_id, entity, row.id);
  if (entity === 'contacts') Object.assign(out, {
    deals: q(DEF.deals.select + ' AND d.contact_id=? ORDER BY d.id DESC', ctx.user.org_id, row.id),
    enrollments: q('SELECT e.*, s.name sequence_name FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE e.contact_id=? ORDER BY e.id DESC', row.id),
    timeline: core.timeline(ctx.user.org_id, { contact_id: row.id }), files,
  });
  if (entity === 'companies') Object.assign(out, {
    contacts: q(DEF.contacts.select + ' AND c.company_id=? ORDER BY c.name', ctx.user.org_id, row.id),
    deals: q(DEF.deals.select + ' AND d.company_id=? ORDER BY d.id DESC', ctx.user.org_id, row.id),
    timeline: core.timeline(ctx.user.org_id, { company_id: row.id }), files,
  });
  if (entity === 'deals') Object.assign(out, {
    contact: row.contact_id ? one('SELECT * FROM contacts WHERE id=?', row.contact_id) : null,
    stages: q('SELECT * FROM stages WHERE pipeline_id=? ORDER BY position', row.pipeline_id),
    quotes: q('SELECT * FROM quotes WHERE deal_id=? ORDER BY id DESC', row.id).map(qt => ({ ...qt, total: require('./sales').quoteTotals(qt.id).total })),
    timeline: core.timeline(ctx.user.org_id, { deal_id: row.id }), files,
  });
  return out;
}

// Deal stage transitions: history, closed_at, contact lifecycle, events.
function afterDealChange(ctx, before, after) {
  if (before && before.stage_id === after.stage_id) return;
  const to = one('SELECT * FROM stages WHERE id=?', after.stage_id), from = before ? one('SELECT * FROM stages WHERE id=?', before.stage_id) : null;
  insert('deal_history', { org_id: after.org_id, deal_id: after.id, from_stage: from?.id ?? null, to_stage: to.id, user_id: ctx.user?.id ?? null });
  run(`UPDATE deals SET stage_changed_at=CURRENT_TIMESTAMP, stall_notified_at=NULL, closed_at=? WHERE id=?`, to.kind === 'open' ? null : U.isoNow(), after.id);
  if (!before) return;
  if (to.kind === 'won' && after.contact_id) run("UPDATE contacts SET lifecycle='customer', updated_at=CURRENT_TIMESTAMP WHERE id=?", after.contact_id);
  const deal = one('SELECT * FROM deals WHERE id=?', after.id);
  core.emit(after.org_id, 'deal.stage_changed', { deal, from_stage: from, to_stage: to });
  if (to.kind === 'won') core.emit(after.org_id, 'deal.won', { deal, to_stage: to });
  if (to.kind === 'lost') core.emit(after.org_id, 'deal.lost', { deal, to_stage: to });
}

function createRecord(ctx, entity, body) {
  const org = ctx.org;
  if (entity === 'contacts') {
    const lim = limits(org).contacts;
    if (lim != null && one('SELECT COUNT(*) n FROM contacts WHERE org_id=?', org.id).n >= lim) bad(`Your plan allows ${lim} contacts — upgrade to add more`, 402);
    const e = normEmail(body.email);
    const dup = e && one('SELECT id, name FROM contacts WHERE org_id=? AND lower(email)=?', org.id, e);
    if (dup && !body.force) bad(`A contact with this email already exists (${dup.name})`, 409, { duplicate_id: dup.id });
  }
  if (entity === 'companies' && !body.force) {
    const dup = one('SELECT id, name FROM companies WHERE org_id=? AND lower(name)=lower(?)', org.id, clean(body.name) || '');
    if (dup) bad(`A company named "${dup.name}" already exists`, 409, { duplicate_id: dup.id });
  }
  const o = prepare(ctx, entity, body, null);
  if (!('owner_id' in o) && entity !== 'companies') o.owner_id = ctx.user.id;
  if (entity === 'activities') { o.user_id = ctx.user.id; o.type ||= 'task'; }
  const id = tx(() => {
    const id = insert(entity, { org_id: org.id, ...o });
    if (entity === 'deals') afterDealChange(ctx, null, one('SELECT * FROM deals WHERE id=?', id));
    return id;
  });
  const row = one(`SELECT * FROM ${entity} WHERE id=?`, id);
  core.audit(ctx, 'create', ENTITY[entity], id, { name: row.name || row.title || row.subject || undefined });
  if (entity === 'contacts') { core.scoreContact(id); core.emit(org.id, 'contact.created', { contact: row }); if (row.lifecycle === 'lead') core.emit(org.id, 'lead.created', { contact: row }); }
  if (entity === 'deals') core.emit(org.id, 'deal.created', { deal: row });
  if (entity === 'companies') core.emit(org.id, 'company.created', { company: row });
  if (row.owner_id && row.owner_id !== ctx.user.id) core.notify(org.id, row.owner_id, `${ctx.user.name} assigned you: ${row.name || row.title || row.subject || row.note}`, entity === 'activities' ? '#/tasks' : `#/${entity}/${id}`);
  return decode(one(DEF[entity].select + ` AND ${DEF[entity].alias}.id=?`, org.id, id));
}

function updateRecord(ctx, entity, id, body) {
  const ex = core.getRecord(ctx, entity, id);
  const o = prepare(ctx, entity, body, ex);
  if (entity === 'deals' && 'stage_id' in o && o.stage_id !== ex.stage_id) {
    const to = one('SELECT kind FROM stages WHERE id=?', o.stage_id);
    if (to.kind === 'lost' && !o.lost_reason && !ex.lost_reason && body.require_reason) bad('please choose a lost reason');
    if (to.kind !== 'lost') o.lost_reason = null;
  }
  const cols = Object.keys(o);
  if (cols.length) {
    tx(() => {
      run(`UPDATE ${entity} SET ${cols.map(c => c + '=?').join(',')}${entity === 'activities' ? '' : ', updated_at=CURRENT_TIMESTAMP'} WHERE id=? AND org_id=?`, ...cols.map(c => o[c]), ex.id, ctx.user.org_id);
      if (entity === 'deals') afterDealChange(ctx, ex, one('SELECT * FROM deals WHERE id=?', ex.id));
    });
    const after = one(`SELECT * FROM ${entity} WHERE id=?`, ex.id), changes = core.diff(ex, after); delete changes.custom;
    if (o.custom && o.custom !== ex.custom) changes.custom = ['…', 'updated'];
    if (Object.keys(changes).length) core.audit(ctx, 'update', ENTITY[entity], ex.id, changes);
    if ('owner_id' in o && o.owner_id && o.owner_id !== ex.owner_id && o.owner_id !== ctx.user.id)
      core.notify(ctx.user.org_id, o.owner_id, `${ctx.user.name} assigned you: ${after.name || after.title || after.subject || after.note}`, entity === 'activities' ? '#/tasks' : `#/${entity}/${ex.id}`);
    if (entity === 'contacts') core.scoreContact(ex.id);
    if (entity === 'deals') core.emit(ctx.user.org_id, 'deal.updated', { deal: after, changes });
    if (entity === 'activities' && o.done && !ex.done) core.emit(ctx.user.org_id, 'task.completed', { activity: after });
  }
  return decode(one(DEF[entity].select + ` AND ${DEF[entity].alias}.id=?`, ctx.user.org_id, ex.id));
}

function deleteFiles(orgId, entity, id) {
  for (const f of q('SELECT * FROM files WHERE org_id=? AND entity=? AND entity_id=?', orgId, entity, id)) { try { fs.unlinkSync(f.path); } catch { } }
  run('DELETE FROM files WHERE org_id=? AND entity=? AND entity_id=?', orgId, entity, id);
}
function deleteRecord(ctx, entity, id, erase = false) {
  const ex = core.getRecord(ctx, entity, id), org = ctx.user.org_id;
  if (['rep'].includes(ctx.user.role) && entity !== 'activities' && ex.owner_id !== ctx.user.id) bad('only the owner or a manager can delete this', 403);
  tx(() => {
    if (entity === 'companies') { run('UPDATE contacts SET company_id=NULL WHERE company_id=? AND org_id=?', ex.id, org); run('UPDATE deals SET company_id=NULL WHERE company_id=? AND org_id=?', ex.id, org); run('UPDATE activities SET company_id=NULL WHERE company_id=? AND org_id=?', ex.id, org); }
    if (entity === 'contacts') {
      run('UPDATE deals SET contact_id=NULL WHERE contact_id=? AND org_id=?', ex.id, org);
      run('DELETE FROM enrollments WHERE contact_id=? AND org_id=?', ex.id, org);
      if (erase) { run('DELETE FROM emails WHERE contact_id=? AND org_id=?', ex.id, org); run('DELETE FROM activities WHERE contact_id=? AND org_id=?', ex.id, org); run("DELETE FROM audit WHERE org_id=? AND entity='contact' AND entity_id=?", org, ex.id); }
      else { run('UPDATE activities SET contact_id=NULL WHERE contact_id=? AND org_id=?', ex.id, org); run('UPDATE emails SET contact_id=NULL WHERE contact_id=? AND org_id=?', ex.id, org); }
    }
    if (entity === 'deals') run('DELETE FROM activities WHERE deal_id=? AND org_id=?', ex.id, org);
    deleteFiles(org, entity, ex.id);
    run(`DELETE FROM ${entity} WHERE id=? AND org_id=?`, ex.id, org);
  });
  core.audit(ctx, erase ? 'erase' : 'delete', ENTITY[entity], ex.id, erase ? { gdpr: true } : { name: ex.name || ex.title || ex.subject || undefined });
}

// ---------- import
const IMPORT_FIELDS = {
  contacts: ['name', 'first_name', 'last_name', 'email', 'phone', 'title', 'company', 'lifecycle', 'source', 'owner_email'],
  companies: ['name', 'website', 'industry', 'size', 'phone', 'description', 'owner_email'],
  deals: ['title', 'value', 'pipeline', 'stage', 'close_date', 'contact_email', 'company', 'owner_email'],
};
function importRows(ctx, entity, rows, mapping, mode) {
  const org = ctx.org, res = { created: 0, updated: 0, skipped: 0, errors: [] };
  const users = Object.fromEntries(q('SELECT id, lower(email) e FROM users WHERE org_id=?', org.id).map(u => [u.e, u.id]));
  const custom = new Set(core.fieldDefs(org.id, entity).map(f => 'custom.' + f.key));
  const fields = Object.entries(mapping).filter(([, f]) => f && (IMPORT_FIELDS[entity].includes(f) || custom.has(f)));
  const lim = limits(org).contacts;
  rows.forEach((row, i) => {
    const r = {}; const cf = {};
    for (const [col, f] of fields) { const v = (row[Number(col)] ?? '').trim(); if (v === '') continue; if (f.startsWith('custom.')) cf[f.slice(7)] = v; else r[f] = v; }
    try {
      const body = { custom: cf };
      if (r.owner_email) { body.owner_id = users[r.owner_email.toLowerCase()]; if (!body.owner_id) throw new Error(`unknown owner ${r.owner_email}`); }
      let existing = null;
      if (entity === 'contacts') {
        body.name = r.name || [r.first_name, r.last_name].filter(Boolean).join(' ') || null;
        Object.assign(body, { email: r.email, phone: r.phone, title: r.title, source: r.source || 'import', company_name: r.company });
        if (r.lifecycle) body.lifecycle = r.lifecycle.toLowerCase();
        const e = normEmail(r.email); existing = e && one('SELECT * FROM contacts WHERE org_id=? AND lower(email)=?', org.id, e);
        if (!existing && lim != null && one('SELECT COUNT(*) n FROM contacts WHERE org_id=?', org.id).n >= lim) throw new Error('contact limit reached on your plan');
      } else if (entity === 'companies') {
        Object.assign(body, { name: r.name, website: r.website, industry: r.industry, size: r.size, phone: r.phone, description: r.description });
        existing = r.name && one('SELECT * FROM companies WHERE org_id=? AND lower(name)=lower(?)', org.id, r.name);
      } else {
        Object.assign(body, { title: r.title, value: r.value ? String(r.value).replace(/[^0-9.]/g, '') : 0, close_date: r.close_date || null });
        if (r.pipeline) { const p = one('SELECT id FROM pipelines WHERE org_id=? AND lower(name)=lower(?)', org.id, r.pipeline); if (!p) throw new Error(`unknown pipeline ${r.pipeline}`); body.pipeline_id = p.id; }
        if (r.stage) {
          const s = one('SELECT id, pipeline_id FROM stages WHERE org_id=? AND lower(name)=lower(?) ' + (body.pipeline_id ? 'AND pipeline_id=?' : 'ORDER BY pipeline_id'), org.id, r.stage, ...(body.pipeline_id ? [body.pipeline_id] : []));
          if (!s) throw new Error(`unknown stage ${r.stage}`); body.stage_id = s.id; body.pipeline_id = s.pipeline_id;
        }
        if (r.contact_email) body.contact_id = one('SELECT id FROM contacts WHERE org_id=? AND lower(email)=?', org.id, normEmail(r.contact_email))?.id ?? null;
        if (r.company) body.company_id = one('SELECT id FROM companies WHERE org_id=? AND lower(name)=lower(?)', org.id, r.company)?.id ?? insert('companies', { org_id: org.id, name: clean(r.company) });
      }
      if (existing && mode === 'skip') { res.skipped++; return; }
      if (existing && mode === 'update') {
        for (const k of Object.keys(body)) if (body[k] == null || body[k] === '' || k === 'source') delete body[k];
        if (!Object.keys(body.custom || {}).length) delete body.custom;
        updateRecord(ctx, entity, existing.id, body); res.updated++; return;
      }
      if (entity === 'contacts' && !body.name) body.name = r.email ? r.email.split('@')[0] : '';
      createRecord(ctx, entity, { ...body, force: true }); res.created++;
    } catch (e) { res.errors.push({ row: i + 2, error: e.message }); }
  });
  core.audit(ctx, 'import', entity, null, { created: res.created, updated: res.updated, skipped: res.skipped, errors: res.errors.length });
  return res;
}

const FILE_DIR = path.join(DATA_DIR, 'files');

module.exports = function (r) {
  for (const entity of Object.keys(DEF)) {
    r.get(`/api/${entity}`, ctx => {
      const { sql, args } = buildQuery(ctx, entity, ctx.query);
      const limit = Math.min(Number(ctx.query.get('limit')) || 200, 2000), offset = Math.max(Number(ctx.query.get('offset')) || 0, 0);
      const total = one(`SELECT COUNT(*) n FROM (${sql})`, ...args).n;
      return { rows: q(sql + ' LIMIT ? OFFSET ?', ...args, limit, offset).map(decode), total };
    });
    r.get(`/api/${entity}/:id`, ctx => (entity === 'activities' ? decode(core.getRecord(ctx, entity, ctx.params.id)) : detail(ctx, entity, ctx.params.id)));
    r.post(`/api/${entity}`, ctx => createRecord(ctx, entity, ctx.body));
    r.patch(`/api/${entity}/:id`, ctx => updateRecord(ctx, entity, ctx.params.id, ctx.body));
    r.del(`/api/${entity}/:id`, ctx => deleteRecord(ctx, entity, ctx.params.id, ctx.query.get('erase') === '1' && ['owner', 'admin'].includes(ctx.user.role)));
    r.post(`/api/${entity}/bulk`, ctx => {
      const { ids, action, value } = ctx.body; if (!Array.isArray(ids) || !ids.length || ids.length > 1000) bad('select 1–1000 records');
      let n = 0; const errors = [];
      for (const id of ids) {
        try {
          if (action === 'delete') deleteRecord(ctx, entity, id);
          else if (action === 'assign') updateRecord(ctx, entity, id, { owner_id: value });
          else if (action === 'stage' && entity === 'deals') updateRecord(ctx, entity, id, { stage_id: value });
          else if (action === 'lifecycle' && entity === 'contacts') updateRecord(ctx, entity, id, { lifecycle: value });
          else if (action === 'done' && entity === 'activities') updateRecord(ctx, entity, id, { done: true });
          else if (action === 'enroll' && entity === 'contacts') { require('../lib/plans').requireFeature(ctx.org, 'sequences'); core.getRecord(ctx, 'contacts', id); require('../lib/sequences').enroll(ctx.org.id, Number(value), Number(id), ctx.user.id); }
          else bad('unknown bulk action');
          n++;
        } catch (e) { errors.push({ id, error: e.message }); }
      }
      return { updated: n, errors };
    });
  }

  r.get('/api/search', ctx => {
    const term = clean(ctx.query.get('q') || ''); if (term.length < 2) return { contacts: [], companies: [], deals: [] };
    const qs = new URLSearchParams({ q: term });
    const top = e => { const { sql, args } = buildQuery(ctx, e, qs); return q(sql + ' LIMIT 8', ...args); };
    return { contacts: top('contacts').map(c => ({ id: c.id, name: c.name, sub: c.email || c.company_name })), companies: top('companies').map(c => ({ id: c.id, name: c.name, sub: c.industry || c.website })),
      deals: top('deals').map(d => ({ id: d.id, name: d.title, sub: `${d.stage_name} · ${d.value}` })) };
  });

  // CSV export honours the same filters as the list view.
  r.get('/api/export/:entity', ctx => {
    const entity = ctx.params.entity; if (!DEF[entity]) bad('not found', 404);
    const { sql, args } = buildQuery(ctx, entity, ctx.query); const rows = q(sql + ' LIMIT 50000', ...args);
    const defs = DEF[entity].custom ? core.fieldDefs(ctx.org.id, entity) : [];
    const cols = { contacts: ['id', 'name', 'email', 'phone', 'title', 'company_name', 'lifecycle', 'source', 'lead_score', 'owner_name', 'created_at'],
      companies: ['id', 'name', 'website', 'industry', 'size', 'phone', 'description', 'contact_count', 'owner_name', 'created_at'],
      deals: ['id', 'title', 'value', 'pipeline_name', 'stage_name', 'stage_kind', 'probability', 'close_date', 'contact_name', 'contact_email', 'company_name', 'owner_name', 'lost_reason', 'created_at', 'closed_at'],
      activities: ['id', 'type', 'subject', 'note', 'due_date', 'start_at', 'done', 'outcome', 'deal_title', 'contact_name', 'owner_name', 'created_at'] }[entity];
    const csv = U.toCsv([[...cols, ...defs.map(d => d.label)], ...rows.map(rw => { const c = json(rw.custom, {}); return [...cols.map(k => rw[k]), ...defs.map(d => c[d.key])]; })]);
    core.audit(ctx, 'export', entity, null, { rows: rows.length });
    ctx.send(csv, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${entity}-${new Date().toISOString().slice(0, 10)}.csv"` });
  });

  r.get('/api/import/:entity/fields', ctx => {
    const e = ctx.params.entity; if (!IMPORT_FIELDS[e]) bad('not found', 404);
    return [...IMPORT_FIELDS[e], ...core.fieldDefs(ctx.org.id, e).map(f => 'custom.' + f.key)];
  });
  r.post('/api/import/:entity', { maxBody: 20e6 }, ctx => {
    const e = ctx.params.entity; if (!IMPORT_FIELDS[e]) bad('not found', 404);
    const rows = Array.isArray(ctx.body.rows) ? ctx.body.rows : U.parseCsv(ctx.body.csv || '');
    if (ctx.body.has_header !== false && !Array.isArray(ctx.body.rows)) rows.shift();
    if (rows.length > 20000) bad('import at most 20,000 rows at a time');
    return importRows(ctx, e, rows, ctx.body.mapping || {}, ['skip', 'update', 'create'].includes(ctx.body.mode) ? ctx.body.mode : 'skip');
  });

  // Duplicates & merge
  r.get('/api/duplicates/:entity', ctx => {
    const org = ctx.org.id;
    if (ctx.params.entity === 'contacts') {
      const groups = [
        ...q(`SELECT 'email' reason, lower(email) k, group_concat(id) ids FROM contacts WHERE org_id=? AND email IS NOT NULL AND email<>'' GROUP BY lower(email) HAVING COUNT(*)>1`, org),
        ...q(`SELECT 'name' reason, lower(trim(name)) || '|' || IFNULL(company_id,'') k, group_concat(id) ids FROM contacts WHERE org_id=? GROUP BY lower(trim(name)), company_id HAVING COUNT(*)>1`, org),
      ];
      const seen = new Set();
      return groups.filter(g => { const key = g.ids.split(',').sort().join(); if (seen.has(key)) return false; seen.add(key); return true; })
        .map(g => ({ reason: g.reason, records: g.ids.split(',').map(id => one(DEF.contacts.select + ' AND c.id=?', org, Number(id))).filter(x => x && core.canSee(ctx.user, x.owner_id)) }))
        .filter(g => g.records.length > 1);
    }
    if (ctx.params.entity === 'companies') {
      return q(`SELECT lower(trim(name)) k, group_concat(id) ids FROM companies WHERE org_id=? GROUP BY lower(trim(name)) HAVING COUNT(*)>1
        UNION SELECT domain k, group_concat(id) ids FROM companies WHERE org_id=? AND domain IS NOT NULL GROUP BY domain HAVING COUNT(*)>1`, org, org)
        .map(g => ({ reason: 'name/domain', records: g.ids.split(',').map(id => one(DEF.companies.select + ' AND co.id=?', org, Number(id))) }));
    }
    bad('not found', 404);
  });
  r.post('/api/merge/:entity', ctx => {
    const e = ctx.params.entity; if (!['contacts', 'companies'].includes(e)) bad('not found', 404);
    const keep = core.getRecord(ctx, e, ctx.body.keep_id), ids = (ctx.body.merge_ids || []).map(Number).filter(id => id !== keep.id);
    if (!ids.length) bad('choose records to merge');
    const org = ctx.org.id;
    tx(() => {
      for (const id of ids) {
        const m = core.getRecord(ctx, e, id); const fill = {};
        for (const [k, v] of Object.entries(m)) if (!['id', 'org_id', 'created_at', 'updated_at', 'custom'].includes(k) && (keep[k] == null || keep[k] === '') && v != null && v !== '') fill[k] = v;
        fill.custom = JSON.stringify({ ...json(m.custom, {}), ...json(keep.custom, {}) });
        run(`UPDATE ${e} SET ${Object.keys(fill).map(k => k + '=?').join(',')} WHERE id=?`, ...Object.values(fill), keep.id); Object.assign(keep, fill);
        if (e === 'contacts') for (const t of ['deals', 'activities', 'emails', 'enrollments']) run(`UPDATE ${t} SET contact_id=? WHERE contact_id=? AND org_id=?`, keep.id, id, org);
        else for (const t of ['contacts', 'deals', 'activities']) run(`UPDATE ${t} SET company_id=? WHERE company_id=? AND org_id=?`, keep.id, id, org);
        run('UPDATE files SET entity_id=? WHERE entity=? AND entity_id=? AND org_id=?', keep.id, e, id, org);
        run(`DELETE FROM ${e} WHERE id=? AND org_id=?`, id, org);
      }
    });
    if (e === 'contacts') core.scoreContact(keep.id);
    core.audit(ctx, 'merge', ENTITY[e], keep.id, { merged: ids });
    return { ok: true, id: keep.id };
  });

  // Attachments (raw upload body; stored on disk outside the web root)
  r.post('/api/files', { raw: true, maxBody: 15e6 }, ctx => {
    const entity = ctx.query.get('entity'); if (!['contacts', 'companies', 'deals'].includes(entity)) bad('invalid entity');
    const rec = core.getRecord(ctx, entity, ctx.query.get('id'));
    const name = clean(decodeURIComponent(String(ctx.req.headers['x-filename'] || 'file'))).replace(/[\\/\r\n"]/g, '_').slice(0, 200) || 'file';
    if (!ctx.rawBody?.length) bad('empty file');
    const dir = path.join(FILE_DIR, String(ctx.org.id)); fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, crypto.randomUUID()); fs.writeFileSync(p, ctx.rawBody);
    const id = insert('files', { org_id: ctx.org.id, entity, entity_id: rec.id, name, mime: String(ctx.req.headers['content-type'] || 'application/octet-stream').slice(0, 100), size: ctx.rawBody.length, path: p, user_id: ctx.user.id });
    core.audit(ctx, 'upload', ENTITY[entity], rec.id, { file: name });
    return { id, name, size: ctx.rawBody.length };
  });
  const getFile = ctx => { const f = one('SELECT * FROM files WHERE id=? AND org_id=?', Number(ctx.params.id), ctx.org.id); if (!f) bad('not found', 404); core.getRecord(ctx, f.entity, f.entity_id); return f; };
  r.get('/api/files/:id', ctx => {
    const f = getFile(ctx);
    ctx.send(fs.readFileSync(f.path), 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${encodeURIComponent(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'X-Content-Type-Options': 'nosniff' });
  });
  r.del('/api/files/:id', ctx => { const f = getFile(ctx); try { fs.unlinkSync(f.path); } catch { } run('DELETE FROM files WHERE id=?', f.id); core.audit(ctx, 'delete_file', ENTITY[f.entity], f.entity_id, { file: f.name }); });

  return { DEF, buildQuery, createRecord, updateRecord, LIFECYCLES, ACT_TYPES };
};
module.exports.DEF = DEF;
