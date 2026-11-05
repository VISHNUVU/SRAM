// Email sequences (cadences): ordered steps of emails and tasks with day delays. Replies and unsubscribes stop them.
const { q, one, run, insert } = require('./db');
const { json, bad, now } = require('./util');

const DAY = Number(process.env.SEQUENCE_DAY_MS || 864e5); // overridable for testing

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) bad('a sequence needs at least one step');
  for (const s of steps) {
    if (!['email', 'task'].includes(s.type)) bad('step type must be email or task');
    if (s.type === 'email' && !s.template_id) bad('email steps need a template');
    if (!(Number(s.delay_days) >= 0)) bad('delay_days must be 0 or more');
  }
  return steps.map(s => ({ type: s.type, delay_days: Number(s.delay_days), template_id: s.template_id ? Number(s.template_id) : null, note: s.note || null }));
}

function enroll(orgId, sequenceId, contactId, userId, dealId = null) {
  const seq = one('SELECT * FROM sequences WHERE id=? AND org_id=? AND active=1', sequenceId, orgId); if (!seq) bad('sequence not found or inactive');
  const c = one('SELECT * FROM contacts WHERE id=? AND org_id=?', contactId, orgId); if (!c) bad('contact not found');
  if (c.unsubscribed) bad(`${c.name} has unsubscribed`);
  if (one("SELECT 1 FROM enrollments WHERE sequence_id=? AND contact_id=? AND status='active'", sequenceId, contactId)) bad(`${c.name} is already in this sequence`, 409);
  const steps = json(seq.steps, []);
  return insert('enrollments', { org_id: orgId, sequence_id: sequenceId, contact_id: contactId, deal_id: dealId, user_id: userId ?? c.owner_id, step: 0,
    next_run_at: now() + (steps[0]?.delay_days || 0) * DAY });
}

function processDue() {
  const { queueEmail, mergeContext, renderTemplate } = require('./email');
  let n = 0;
  for (const e of q("SELECT * FROM enrollments WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT 200", now())) {
    const seq = one('SELECT * FROM sequences WHERE id=?', e.sequence_id), steps = json(seq?.steps, []), step = steps[e.step];
    const contact = one('SELECT * FROM contacts WHERE id=?', e.contact_id);
    if (!seq || !seq.active || !contact) { run("UPDATE enrollments SET status='stopped' WHERE id=?", e.id); continue; }
    if (contact.unsubscribed) { run("UPDATE enrollments SET status='unsubscribed' WHERE id=?", e.id); continue; }
    if (!step) { run("UPDATE enrollments SET status='finished' WHERE id=?", e.id); continue; }
    const user = e.user_id ? one('SELECT * FROM users WHERE id=?', e.user_id) : null;
    const deal = e.deal_id ? one('SELECT * FROM deals WHERE id=?', e.deal_id) : null;
    try {
      if (step.type === 'email') {
        const tpl = one('SELECT * FROM email_templates WHERE id=? AND org_id=?', step.template_id, e.org_id);
        if (tpl) { const m = renderTemplate(tpl, mergeContext(contact, deal, user)); queueEmail({ orgId: e.org_id, user, contact, dealId: e.deal_id, subject: m.subject, body: m.body, enrollmentId: e.id }); }
      } else {
        insert('activities', { org_id: e.org_id, type: 'task', note: step.note || `Sequence "${seq.name}" step ${e.step + 1}`, due_date: new Date().toISOString().slice(0, 10),
          contact_id: contact.id, deal_id: e.deal_id, owner_id: e.user_id });
      }
    } catch (err) { run("UPDATE enrollments SET status='error' WHERE id=?", e.id); continue; }
    const next = steps[e.step + 1];
    if (next) run('UPDATE enrollments SET step=step+1, next_run_at=? WHERE id=?', now() + next.delay_days * DAY, e.id);
    else run("UPDATE enrollments SET step=step+1, status='finished' WHERE id=?", e.id);
    n++;
  }
  return n;
}

module.exports = { enroll, processDue, validateSteps };
