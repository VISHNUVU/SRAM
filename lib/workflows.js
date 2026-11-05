// Automation engine: "when <trigger> and <conditions> then <actions>".
const { q, one, run, insert } = require('./db');
const { json, render, isoNow, assertPublicUrl } = require('./util');
const { limits } = require('./plans');

const TRIGGERS = ['deal.created', 'deal.updated', 'deal.stage_changed', 'deal.won', 'deal.lost', 'contact.created', 'lead.created', 'quote.accepted',
  'email.received', 'email.opened', 'meeting.booked', 'task.completed'];
const ACTIONS = ['create_task', 'notify', 'send_email', 'update_deal', 'update_contact', 'enroll_sequence', 'assign_round_robin', 'webhook', 'slack'];
const OPS = ['eq', 'neq', 'gt', 'lt', 'contains', 'empty', 'not_empty'];
const DEAL_FIELDS = ['owner_id', 'value', 'close_date'], CONTACT_FIELDS = ['lifecycle', 'owner_id', 'source'];

function get(obj, path) { let v = obj; for (const k of String(path).split('.')) v = v == null ? undefined : v[k]; return v; }
function test(cond, data) {
  const v = get(data, cond.field), s = v == null ? '' : String(v).toLowerCase(), t = String(cond.value ?? '').toLowerCase();
  switch (cond.op) {
    case 'eq': return s === t; case 'neq': return s !== t; case 'gt': return Number(v) > Number(cond.value); case 'lt': return Number(v) < Number(cond.value);
    case 'contains': return s.includes(t); case 'empty': return s === ''; case 'not_empty': return s !== ''; default: return false;
  }
}

function validate(trigger, conditions, actions) {
  const err = m => { throw Object.assign(new Error(m), { code: 400 }); };
  if (!TRIGGERS.includes(trigger)) err('invalid trigger');
  if (!Array.isArray(conditions) || !Array.isArray(actions) || !actions.length) err('conditions must be a list and at least one action is required');
  for (const c of conditions) if (!c.field || !OPS.includes(c.op)) err('invalid condition');
  for (const a of actions) {
    if (!ACTIONS.includes(a.type)) err('invalid action type ' + a.type);
    if (a.type === 'update_deal' && !DEAL_FIELDS.includes(a.field)) err('update_deal field must be one of ' + DEAL_FIELDS.join(', '));
    if (a.type === 'update_contact' && !CONTACT_FIELDS.includes(a.field)) err('update_contact field must be one of ' + CONTACT_FIELDS.join(', '));
    if ((a.type === 'webhook' && !a.url) || (a.type === 'slack' && !a.webhook_url)) err('URL required');
  }
}

function enrich(orgId, data) {
  const d = { ...data };
  if (d.deal && !d.contact && d.deal.contact_id) d.contact = one('SELECT * FROM contacts WHERE id=? AND org_id=?', d.deal.contact_id, orgId);
  if (!d.company) { const cid = d.deal?.company_id || d.contact?.company_id; if (cid) d.company = one('SELECT * FROM companies WHERE id=? AND org_id=?', cid, orgId); }
  if (d.deal && !d.stage) d.stage = one('SELECT name, kind, probability FROM stages WHERE id=?', d.deal.stage_id);
  for (const k of ['deal', 'contact', 'company']) if (d[k]?.custom && typeof d[k].custom === 'string') d[k] = { ...d[k], custom: json(d[k].custom, {}) };
  d.owner = one('SELECT id, name, email, manager_id FROM users WHERE id=?', d.deal?.owner_id || d.contact?.owner_id || 0) || null;
  return d;
}
function resolveUser(orgId, who, data) {
  if (who === 'owner' || !who) return data.owner?.id || null;
  if (who === 'manager') return data.owner?.manager_id || null;
  return one('SELECT id FROM users WHERE id=? AND org_id=?', Number(who), orgId)?.id || null;
}

async function execute(orgId, a, data, depth) {
  const core = require('./core');
  const text = s => render(s, data);
  switch (a.type) {
    case 'create_task': {
      const due = new Date(Date.now() + (Number(a.due_in_days) || 0) * 864e5).toISOString().slice(0, 10);
      const owner = resolveUser(orgId, a.assign, data);
      insert('activities', { org_id: orgId, type: a.task_type || 'task', note: text(a.note || 'Follow up'), due_date: due, deal_id: data.deal?.id ?? null,
        contact_id: data.contact?.id ?? null, owner_id: owner, user_id: null });
      if (owner) core.notify(orgId, owner, `New task: ${text(a.note || 'Follow up')}`, '#/tasks');
      break;
    }
    case 'notify': core.notify(orgId, resolveUser(orgId, a.to, data), text(a.text || 'Workflow notification'), data.deal ? `#/deals/${data.deal.id}` : data.contact ? `#/contacts/${data.contact.id}` : null, { email: !!a.email }); break;
    case 'send_email': {
      const tpl = one('SELECT * FROM email_templates WHERE id=? AND org_id=?', Number(a.template_id), orgId); if (!tpl || !data.contact?.email) break;
      const { mergeContext, renderTemplate, queueEmail } = require('./email');
      const sender = data.owner ? one('SELECT * FROM users WHERE id=?', data.owner.id) : null;
      const contact = one('SELECT * FROM contacts WHERE id=?', data.contact.id);
      if (contact.unsubscribed) break;
      const m = renderTemplate(tpl, mergeContext(contact, data.deal, sender));
      queueEmail({ orgId, user: sender, contact, dealId: data.deal?.id ?? null, subject: m.subject, body: m.body });
      break;
    }
    case 'update_deal': if (data.deal) run(`UPDATE deals SET ${a.field}=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?`, a.value === '' ? null : a.value, data.deal.id, orgId); break;
    case 'update_contact': if (data.contact) run(`UPDATE contacts SET ${a.field}=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?`, a.value === '' ? null : a.value, data.contact.id, orgId); break;
    case 'assign_round_robin': {
      const uid = core.nextAssignee(orgId);
      if (data.deal) run('UPDATE deals SET owner_id=? WHERE id=? AND org_id=?', uid, data.deal.id, orgId);
      else if (data.contact) run('UPDATE contacts SET owner_id=? WHERE id=? AND org_id=?', uid, data.contact.id, orgId);
      core.notify(orgId, uid, `Assigned to you: ${data.deal?.title || data.contact?.name}`, data.deal ? `#/deals/${data.deal.id}` : `#/contacts/${data.contact?.id}`);
      break;
    }
    case 'enroll_sequence': if (data.contact) require('./sequences').enroll(orgId, Number(a.sequence_id), data.contact.id, data.owner?.id, data.deal?.id); break;
    case 'webhook': await assertPublicUrl(a.url); core.enqueue('http_post', { url: a.url, body: { event: data._event, data } }); break;
    case 'slack': await assertPublicUrl(a.webhook_url); core.enqueue('http_post', { url: a.webhook_url, body: { text: text(a.text || '{{deal.title}}') } }); break;
  }
}

async function runFlows(orgId, event, data, depth = 0) {
  const org = one('SELECT * FROM orgs WHERE id=?', orgId);
  if (!org || !limits(org).features.includes('automation')) return;
  const flows = q('SELECT * FROM workflows WHERE org_id=? AND trigger=? AND active=1', orgId, event); if (!flows.length) return;
  const d = { ...enrich(orgId, data), _event: event };
  for (const f of flows) {
    if (!json(f.conditions, []).every(c => test(c, d))) continue;
    try {
      for (const a of json(f.actions, [])) await execute(orgId, a, d, depth);
      run('UPDATE workflows SET runs=runs+1, last_error=NULL WHERE id=?', f.id);
    } catch (e) { run('UPDATE workflows SET last_error=? WHERE id=?', `${isoNow()}: ${e.message}`.slice(0, 500), f.id); }
  }
}
// Fire-and-forget from request handlers; errors are recorded on the workflow.
function runAsync(orgId, event, data, depth) { runFlows(orgId, event, data, depth).catch(e => console.error('workflow error', e)); }

module.exports = { run: runAsync, runFlows, validate, TRIGGERS, ACTIONS, OPS, DEAL_FIELDS, CONTACT_FIELDS };
