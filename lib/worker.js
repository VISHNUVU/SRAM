// Background worker: DB-backed job queue with retries + periodic tasks (sequences, reminders, stalled deals, Gmail sync, cleanup).
const { q, one, run } = require('./db');
const { json, now, hmac, safeFetch, isoNow } = require('./util');

const handlers = {
  async send_email({ email_id }) { await require('./email').deliver(email_id); },
  async system_email(p) { await require('./email').sendSystem(p); },
  async webhook({ webhook_id, event, data, at }) {
    const h = one('SELECT * FROM webhooks WHERE id=? AND active=1', webhook_id); if (!h) return;
    const body = JSON.stringify({ event, at, org_id: h.org_id, data });
    const r = await safeFetch(h.url, { method: 'POST', body, timeout: 10000, headers: { 'Content-Type': 'application/json', 'User-Agent': 'PipelineHQ-Webhooks/1',
      'X-PipelineHQ-Event': event, 'X-PipelineHQ-Signature': 'sha256=' + hmac(h.secret, body) } }, 1e5);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
  async http_post({ url, body }) {
    const r = await safeFetch(url, { method: 'POST', body: JSON.stringify(body), timeout: 10000, headers: { 'Content-Type': 'application/json' } }, 1e5);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
};

let busy = false;
async function runJobs(limit = 50) {
  if (busy) return 0; busy = true; let n = 0;
  try {
    for (const j of q("SELECT * FROM jobs WHERE status='queued' AND run_at<=? ORDER BY run_at LIMIT ?", now(), limit)) {
      if (run("UPDATE jobs SET status='running' WHERE id=? AND status='queued'", j.id).changes !== 1) continue;
      try { await handlers[j.type](json(j.payload, {})); run("UPDATE jobs SET status='done', attempts=attempts+1 WHERE id=?", j.id); n++; }
      catch (e) {
        const attempts = j.attempts + 1, failed = attempts >= 5 || j.type === 'send_email'; // emails are not retried blindly (avoid duplicates)
        run('UPDATE jobs SET status=?, attempts=?, last_error=?, run_at=? WHERE id=?', failed ? 'failed' : 'queued', attempts, String(e.message).slice(0, 500), now() + 2 ** attempts * 60e3, j.id);
      }
    }
  } finally { busy = false; }
  return n;
}

function reminders() {
  const core = require('./core'); const today = new Date().toISOString().slice(0, 10);
  for (const a of q("SELECT * FROM activities WHERE done=0 AND notified=0 AND due_date IS NOT NULL AND due_date<? AND owner_id IS NOT NULL LIMIT 500", today)) {
    core.notify(a.org_id, a.owner_id, `Overdue: ${a.subject || a.note || a.type}`, '#/tasks', { email: true });
    run('UPDATE activities SET notified=1 WHERE id=?', a.id);
  }
  // meetings starting in the next 15 minutes
  const soon = new Date(now() + 15 * 60e3).toISOString().replace('T', ' ').slice(0, 19);
  for (const a of q("SELECT * FROM activities WHERE type='meeting' AND done=0 AND notified=0 AND start_at IS NOT NULL AND start_at<=? AND start_at>=? LIMIT 500", soon, isoNow())) {
    core.notify(a.org_id, a.owner_id, `Starting soon: ${a.subject || 'Meeting'}`, a.contact_id ? `#/contacts/${a.contact_id}` : '#/tasks');
    run('UPDATE activities SET notified=1 WHERE id=?', a.id);
  }
  for (const d of q(`SELECT d.*, o.stall_days FROM deals d JOIN orgs o ON o.id=d.org_id JOIN stages s ON s.id=d.stage_id
      WHERE s.kind='open' AND d.owner_id IS NOT NULL AND julianday('now') - julianday(d.stage_changed_at) > o.stall_days
      AND (d.stall_notified_at IS NULL OR julianday('now') - julianday(d.stall_notified_at) > o.stall_days) LIMIT 500`)) {
    core.notify(d.org_id, d.owner_id, `Stalled deal: "${d.title}" hasn't moved in ${d.stall_days}+ days`, `#/deals/${d.id}`);
    run('UPDATE deals SET stall_notified_at=CURRENT_TIMESTAMP WHERE id=?', d.id);
  }
}

function cleanup() {
  run('DELETE FROM sessions WHERE expires<?', now());
  run('DELETE FROM tokens WHERE expires<?', now() - 864e5);
  run("DELETE FROM jobs WHERE status='done' AND created_at < datetime('now','-7 days')");
  run("DELETE FROM notifications WHERE read=1 AND created_at < datetime('now','-90 days')");
}

async function tick() { require('./sequences').processDue(); await runJobs(); }
const safe = fn => () => Promise.resolve().then(fn).catch(e => console.error('worker:', e.message));
function start() {
  const timers = [setInterval(safe(tick), 5000), setInterval(safe(reminders), 5 * 60e3), setInterval(safe(() => require('./google').syncAll()), 5 * 60e3), setInterval(safe(cleanup), 3600e3)];
  timers.forEach(t => t.unref());
  safe(reminders)(); safe(cleanup)();
}
module.exports = { start, tick, runJobs, reminders, cleanup };
