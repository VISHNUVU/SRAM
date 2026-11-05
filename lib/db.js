// SQLite storage (node:sqlite), versioned migrations, small query helpers.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'crm.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

const MIGRATIONS = [
  `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE orgs(id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', sub_status TEXT, seats INTEGER NOT NULL DEFAULT 3,
    trial_ends_at INTEGER, stripe_customer TEXT, stripe_sub TEXT, currency TEXT NOT NULL DEFAULT 'USD', timezone TEXT NOT NULL DEFAULT 'UTC',
    stall_days INTEGER NOT NULL DEFAULT 14, inbound_token TEXT UNIQUE, rr_index INTEGER NOT NULL DEFAULT 0,
    lost_reasons TEXT NOT NULL DEFAULT '["Price","Competitor","No budget","No decision","Timing","Other"]', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'rep', manager_id INTEGER, pw TEXT, phone TEXT, active INTEGER NOT NULL DEFAULT 1, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
    calendar_token TEXT UNIQUE, notify_email INTEGER NOT NULL DEFAULT 1, google_refresh TEXT, google_email TEXT, gmail_synced_at INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, impersonator_id INTEGER, expires INTEGER NOT NULL);
  CREATE TABLE tokens(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, org_id INTEGER, email TEXT, role TEXT, user_id INTEGER, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);

  CREATE TABLE companies(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, website TEXT, domain TEXT, industry TEXT, size TEXT,
    description TEXT, phone TEXT, owner_id INTEGER, custom TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE contacts(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, company_id INTEGER, name TEXT NOT NULL, email TEXT, phone TEXT, title TEXT,
    owner_id INTEGER, lifecycle TEXT NOT NULL DEFAULT 'lead', source TEXT, lead_score INTEGER NOT NULL DEFAULT 0, unsubscribed INTEGER NOT NULL DEFAULT 0,
    custom TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE pipelines(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE stages(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, probability INTEGER NOT NULL DEFAULT 10, kind TEXT NOT NULL DEFAULT 'open');
  CREATE TABLE deals(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, pipeline_id INTEGER NOT NULL, stage_id INTEGER NOT NULL, title TEXT NOT NULL,
    value REAL NOT NULL DEFAULT 0, contact_id INTEGER, company_id INTEGER, owner_id INTEGER, close_date TEXT, lost_reason TEXT, closed_at TEXT, stage_changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    stall_notified_at TEXT, custom TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE deal_history(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE, from_stage INTEGER, to_stage INTEGER NOT NULL,
    user_id INTEGER, at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE activities(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, deal_id INTEGER, contact_id INTEGER, company_id INTEGER,
    type TEXT NOT NULL DEFAULT 'task', subject TEXT, note TEXT, due_date TEXT, start_at TEXT, duration_min INTEGER, outcome TEXT, done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
    owner_id INTEGER, user_id INTEGER, notified INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE emails(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, contact_id INTEGER, deal_id INTEGER, user_id INTEGER, direction TEXT NOT NULL,
    from_addr TEXT, to_addr TEXT, subject TEXT, body TEXT, status TEXT NOT NULL DEFAULT 'queued', error TEXT, provider TEXT, message_id TEXT, track_token TEXT UNIQUE,
    open_count INTEGER NOT NULL DEFAULT 0, opened_at TEXT, enrollment_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP, sent_at TEXT);
  CREATE TABLE email_templates(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE sequences(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE enrollments(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL, deal_id INTEGER, user_id INTEGER, step INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE field_defs(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, entity TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text', options TEXT NOT NULL DEFAULT '[]', required INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, UNIQUE(org_id, entity, key));
  CREATE TABLE views(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, entity TEXT NOT NULL, name TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '', shared INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE forms(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, key TEXT UNIQUE NOT NULL,
    fields TEXT NOT NULL DEFAULT '["name","email","company","phone","message"]', assign_mode TEXT NOT NULL DEFAULT 'round_robin', assign_user_id INTEGER, redirect_url TEXT,
    sequence_id INTEGER, submissions INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE scoring_rules(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, field TEXT NOT NULL, op TEXT NOT NULL, value TEXT, points INTEGER NOT NULL);
  CREATE TABLE booking_pages(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    duration_min INTEGER NOT NULL DEFAULT 30, days TEXT NOT NULL DEFAULT '1,2,3,4,5', start_hour INTEGER NOT NULL DEFAULT 9, end_hour INTEGER NOT NULL DEFAULT 17,
    timezone TEXT NOT NULL DEFAULT 'UTC', active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE products(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, sku TEXT, price REAL NOT NULL DEFAULT 0,
    description TEXT, active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE price_books(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL);
  CREATE TABLE price_book_entries(price_book_id INTEGER NOT NULL REFERENCES price_books(id) ON DELETE CASCADE, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price REAL NOT NULL, PRIMARY KEY(price_book_id, product_id));
  CREATE TABLE quotes(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    number TEXT NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'draft', price_book_id INTEGER, discount_pct REAL NOT NULL DEFAULT 0, tax_pct REAL NOT NULL DEFAULT 0,
    notes TEXT, valid_until TEXT, token TEXT UNIQUE NOT NULL, signed_name TEXT, signed_at TEXT, signed_ip TEXT, viewed_at TEXT, created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, sent_at TEXT);
  CREATE TABLE quote_items(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE, product_id INTEGER, name TEXT NOT NULL,
    qty REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0, discount_pct REAL NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE quotas(org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, period TEXT NOT NULL, amount REAL NOT NULL, PRIMARY KEY(org_id, user_id, period));
  CREATE TABLE workflows(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, trigger TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '[]',
    actions TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1, runs INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE webhooks(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE api_keys(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
    prefix TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, last_used TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE notifications(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id INTEGER NOT NULL, text TEXT NOT NULL, link TEXT,
    read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE audit(id INTEGER PRIMARY KEY, org_id INTEGER, user_id INTEGER, impersonator_id INTEGER, action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT, ip TEXT,
    at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE files(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, name TEXT NOT NULL,
    mime TEXT, size INTEGER, path TEXT NOT NULL, user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE jobs(id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, run_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'queued',
    last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

  CREATE INDEX i_users_org ON users(org_id);
  CREATE INDEX i_contacts_org ON contacts(org_id, owner_id); CREATE INDEX i_contacts_email ON contacts(org_id, email);
  CREATE INDEX i_companies_org ON companies(org_id); CREATE INDEX i_deals_org ON deals(org_id, pipeline_id, stage_id);
  CREATE INDEX i_act_org ON activities(org_id, owner_id, done); CREATE INDEX i_act_deal ON activities(deal_id); CREATE INDEX i_act_contact ON activities(contact_id);
  CREATE INDEX i_emails_contact ON emails(org_id, contact_id); CREATE UNIQUE INDEX i_emails_msgid ON emails(org_id, message_id);
  CREATE INDEX i_hist_deal ON deal_history(deal_id); CREATE INDEX i_enr_due ON enrollments(status, next_run_at);
  CREATE INDEX i_jobs_due ON jobs(status, run_at); CREATE INDEX i_audit_org ON audit(org_id, entity, entity_id); CREATE INDEX i_notif_user ON notifications(user_id, read);
  `,
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)');
  const v = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0);
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i].replace('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);', ''));
      db.prepare("INSERT OR REPLACE INTO meta VALUES('schema_version', ?)").run(String(i + 1));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
migrate();

const q = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
function tx(fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function insert(table, obj) {
  const cols = Object.keys(obj);
  return Number(run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, ...cols.map(c => obj[c])).lastInsertRowid);
}
function update(table, id, obj, extraWhere = '', ...extraArgs) {
  const cols = Object.keys(obj); if (!cols.length) return;
  run(`UPDATE ${table} SET ${cols.map(c => c + '=?').join(',')} WHERE id=? ${extraWhere}`, ...cols.map(c => obj[c]), id, ...extraArgs);
}

// App secret: env or generated once and persisted.
let SECRET = process.env.APP_SECRET;
if (!SECRET) {
  SECRET = one("SELECT value FROM meta WHERE key='secret'")?.value;
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); run("INSERT INTO meta VALUES('secret', ?)", SECRET); }
}

module.exports = { db, q, one, run, tx, insert, update, SECRET, DATA_DIR };
