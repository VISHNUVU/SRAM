// Log a received/sent email (from Gmail sync or an inbound-parse webhook / BCC address) onto the matching contact.
const { q, one, run, insert } = require('./db');
const { normEmail, isoNow } = require('./util');

function record(orgId, { from, to = [], subject, text, messageId, userId = null, at }) {
  from = normEmail(from); to = to.map(normEmail).filter(Boolean);
  if (!from) return null;
  const team = q('SELECT id, lower(email) email, lower(google_email) gmail, name FROM users WHERE org_id=?', orgId);
  const sender = team.find(u => u.email === from || u.gmail === from);
  const findContact = e => one('SELECT * FROM contacts WHERE org_id=? AND lower(email)=?', orgId, e);
  let contact, direction;
  if (sender) { direction = 'out'; for (const t of to) { contact = findContact(t); if (contact) break; } userId = sender.id; }
  else { direction = 'in'; contact = findContact(from); }
  if (!contact) return null;
  if (messageId && one('SELECT 1 FROM emails WHERE org_id=? AND message_id=?', orgId, messageId)) return null;
  const sentAt = at ? new Date(at).toISOString().replace('T', ' ').slice(0, 19) : isoNow();
  const id = insert('emails', { org_id: orgId, contact_id: contact.id, user_id: userId, direction, from_addr: from, to_addr: to.join(', '), subject: String(subject || '(no subject)').slice(0, 500),
    body: String(text || '').slice(0, 50000), status: direction === 'in' ? 'received' : 'sent', message_id: messageId || null, sent_at: sentAt,
    deal_id: one("SELECT d.id FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.contact_id=? AND s.kind='open' ORDER BY d.updated_at DESC LIMIT 1", contact.id)?.id || null });
  const core = require('./core');
  if (direction === 'in') {
    const stopped = run("UPDATE enrollments SET status='replied' WHERE contact_id=? AND status='active'", contact.id).changes;
    core.notify(orgId, contact.owner_id, `${contact.name} replied: ${subject || '(no subject)'}${stopped ? ' — sequence stopped' : ''}`, `#/contacts/${contact.id}`, { email: true });
    core.scoreContact(contact.id);
    core.emit(orgId, 'email.received', { email: { id, subject }, contact });
  }
  return id;
}

module.exports = { record };
